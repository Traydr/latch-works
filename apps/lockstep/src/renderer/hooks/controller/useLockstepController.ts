import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../../../shared/types";
import { shouldEndRunOnComplete } from "../../lib/run-lifecycle";
import {
  emptyProfileForm,
  initialProgress,
  type LockstepController,
  type PipelineProgressState,
  type ProfileFormState,
  type RunProgressState,
  type Screen,
} from "./types";

export type {
  LockstepController,
  PipelineProgressState,
  PlanController,
  ProfileController,
  ProfileFormState,
  RunController,
  RunPhase,
  RunProgressState,
  Screen,
  SessionController,
} from "./types";

/**
 * Composes screen-scoped Lockstep controllers (session | profile | plan | run).
 * Prefer depending on a single slice at call sites instead of the full bag.
 */
export function useLockstepController(): LockstepController {
  const [screen, setScreenState] = useState<Screen>("dashboard");
  const [settings, setSettings] = useState<LockstepSettings | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileFormState>(emptyProfileForm);
  const [plan, setPlan] = useState<LockstepPlan | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [runProgress, setRunProgress] = useState<RunProgressState>(initialProgress);
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgressState>({
    reviewed: false,
    pushCompleted: false,
    pruneCompleted: false,
  });
  const lastLoggedScanProgressRef = useRef<string | null>(null);
  const activeRunActionRef = useRef("");

  const activeProfile = useMemo(() => {
    if (!settings?.activeProfileId) {
      return null;
    }
    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? null;
  }, [settings]);

  const refreshSettings = useCallback(async () => {
    const result = await window.lockstep.getSettings();
    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }
    setSettings(result.value);
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const applyRunEvent = useCallback(
    (event: LockstepRunEvent) => {
      if (event.type === "status") {
        setRunLabel(event.message);
        setLogs((current) => [...current.slice(-200), event.message]);
        if (/plan/i.test(event.message)) {
          setRunProgress((prev) => ({ ...prev, phase: "planning", action: "plan" }));
        } else if (/push|upload/i.test(event.message)) {
          setRunProgress((prev) => ({ ...prev, phase: "items", action: "push" }));
        } else if (/prune|delete/i.test(event.message)) {
          setRunProgress((prev) => ({ ...prev, phase: "items", action: "prune" }));
        } else if (/doctor/i.test(event.message)) {
          setRunProgress((prev) => ({ ...prev, phase: "items", action: "doctor" }));
        }
      }

      if (event.type === "scan-progress") {
        const message =
          event.progress.stage === "hashing"
            ? `Hashing ${event.progress.path ?? ""} (${event.progress.filesFound} files)`
            : `Scanning (${event.progress.filesFound} files, ${event.progress.skipped} skipped)`;
        const logKey =
          event.progress.stage === "hashing"
            ? `hashing:${event.progress.path ?? ""}`
            : `scanning:${event.progress.path ?? ""}`;
        setRunLabel(message);
        setRunProgress((prev) => ({
          ...prev,
          phase: event.progress.stage === "hashing" ? "hashing" : "scanning",
          scanFilesFound: event.progress.filesFound,
          scanSkipped: event.progress.skipped,
          bytesHashed: event.progress.bytesHashed ?? prev.bytesHashed,
          fileSize: event.progress.fileSize ?? prev.fileSize,
          scanPath: event.progress.path ?? prev.scanPath,
          scanStage: event.progress.stage,
        }));
        if (lastLoggedScanProgressRef.current !== logKey) {
          lastLoggedScanProgressRef.current = logKey;
          setLogs((current) => [...current.slice(-200), message]);
        }
      }

      if (event.type === "item-success") {
        const message = `[${event.current}/${event.total}] ${event.action} ${event.path}`;
        setLogs((current) => [...current.slice(-200), message]);
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: event.action,
          pushed: prev.pushed + 1,
        }));
      }

      if (event.type === "item-failure") {
        const message = `[${event.current}/${event.total}] failed ${event.path}: ${event.error}`;
        setLogs((current) => [...current.slice(-200), message]);
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: event.action,
          failed: prev.failed + 1,
        }));
      }

      if (event.type === "cancelled") {
        setRunLabel("Run cancelled.");
        setRunProgress((prev) => ({ ...prev, phase: "cancelled", endedAt: Date.now() }));
      }

      if (event.type === "complete") {
        const activeRunAction = activeRunActionRef.current;
        if (!shouldEndRunOnComplete(event.summary.action, activeRunAction)) {
          setRunProgress((prev) => ({
            ...prev,
            phase: "items",
            endedAt: null,
          }));
          return;
        }

        setRunning(false);
        activeRunActionRef.current = "";
        setRunLabel(event.summary.message ?? `${event.summary.action} ${event.summary.status}`);
        setRunProgress((prev) => ({
          ...prev,
          phase: event.summary.status === "cancelled" ? "cancelled" : "done",
          action: event.summary.action,
          itemCurrent: event.summary.status === "cancelled" ? prev.itemCurrent : prev.itemTotal,
          failed: event.summary.failed,
          pushed: event.summary.pushed,
          endedAt: Date.now(),
          summaryMessage: event.summary.message ?? null,
        }));
        if (event.summary.action === "push" && event.summary.status === "completed") {
          setPipelineProgress((prev) => ({ ...prev, pushCompleted: true }));
        }
        if (event.summary.action === "prune" && event.summary.status === "completed") {
          setPipelineProgress((prev) => ({ ...prev, pruneCompleted: true }));
        }
        void refreshSettings();
      }
    },
    [refreshSettings],
  );

  useEffect(() => {
    const unsubscribe = window.lockstep.onRunEvent(applyRunEvent);
    return unsubscribe;
  }, [applyRunEvent]);

  const filteredItems = useMemo(() => {
    if (!plan) {
      return [];
    }
    const query = filter.trim().toLowerCase();
    return plan.items.filter(
      (item) => item.action !== "keep" && (!query || item.path.toLowerCase().includes(query)),
    );
  }, [filter, plan]);

  const ensureSessionToken = useCallback(
    async (profile: LockstepProfilePublic): Promise<boolean> => {
      if (profile.tokenConfigured) {
        return true;
      }
      if (!sessionToken.trim()) {
        setError("Enter a sync API token for this session before running remote operations.");
        return false;
      }
      const result = await window.lockstep.updateProfile(profile.id, {
        token: sessionToken.trim(),
      });
      if (Result.isError(result)) {
        setError(result.error.message);
        return false;
      }
      await refreshSettings();
      return true;
    },
    [refreshSettings, sessionToken],
  );

  const beginRun = useCallback((label: string, action: string) => {
    setError(null);
    setRunning(true);
    activeRunActionRef.current = action;
    setRunLabel(label);
    setLogs([label]);
    lastLoggedScanProgressRef.current = null;
    setRunProgress({ ...initialProgress, phase: "planning", action, startedAt: Date.now() });
    setScreenState("run");
  }, []);

  const markReviewVisited = useCallback(() => {
    setPipelineProgress((prev) => ({ ...prev, reviewed: true }));
  }, []);

  const setScreen = useCallback((next: Screen) => {
    if (next === "plan") {
      setPipelineProgress((prev) => ({ ...prev, reviewed: true }));
    }
    setScreenState(next);
  }, []);

  const handleCreateProfile = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      const result = await window.lockstep.createProfile(profileForm);
      if (Result.isError(result)) {
        setError(result.error.message);
        return;
      }
      setProfileForm(emptyProfileForm);
      await refreshSettings();
      setScreen("dashboard");
    },
    [profileForm, refreshSettings, setScreen],
  );

  const handleDoctor = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return;
    }
    setDoctorResult(null);
    beginRun("Running doctor...", "doctor");
    const result = await window.lockstep.doctor(activeProfile.id);
    setRunning(false);
    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
      return;
    }
    setDoctorResult(result.value);
    setRunLabel(result.value.ok ? "Doctor passed." : "Doctor found issues.");
    setRunProgress((prev) => ({
      ...prev,
      phase: "done",
      endedAt: Date.now(),
      summaryMessage: result.value.ok ? "All checks passed." : "Some checks failed.",
    }));
    await refreshSettings();
  }, [activeProfile, ensureSessionToken, beginRun, refreshSettings]);

  const handlePlan = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return false;
    }
    beginRun("Planning sync...", "plan");
    const result = await window.lockstep.plan({ profileId: activeProfile.id });
    setRunning(false);
    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
      return false;
    }
    setPlan(result.value);
    setPipelineProgress({ reviewed: true, pushCompleted: false, pruneCompleted: false });
    setRunProgress((prev) => ({ ...prev, phase: "done", endedAt: Date.now() }));
    await refreshSettings();
    return true;
  }, [activeProfile, ensureSessionToken, beginRun, refreshSettings]);

  const handlePush = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return;
    }
    beginRun("Pushing uploads and updates...", "push");
    setRunProgress((prev) => ({ ...prev, phase: "items", action: "push" }));
    const result = await window.lockstep.push({ profileId: activeProfile.id });
    setRunning(false);
    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
      return;
    }
    setRunLabel(`Push ${result.value.status}: ${result.value.pushed} item(s).`);
    setRunProgress((prev) => ({
      ...prev,
      phase: result.value.status === "cancelled" ? "cancelled" : "done",
      pushed: result.value.pushed,
      failed: result.value.failed,
      itemCurrent: result.value.status === "cancelled" ? prev.itemCurrent : prev.itemTotal,
      endedAt: Date.now(),
      summaryMessage: `Push ${result.value.status}: ${result.value.pushed} item(s).`,
    }));
    if (result.value.status === "completed") {
      setPipelineProgress((prev) => ({ ...prev, pushCompleted: true }));
    }
    activeRunActionRef.current = "";
    await refreshSettings();
  }, [activeProfile, ensureSessionToken, beginRun, refreshSettings]);

  const handlePrune = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return;
    }
    if (
      !window.confirm("Apply planned remote deletes? This cannot be undone from the desktop app.")
    ) {
      return;
    }
    beginRun("Applying remote deletes...", "prune");
    setRunProgress((prev) => ({ ...prev, phase: "items", action: "prune" }));
    const result = await window.lockstep.prune({ profileId: activeProfile.id });
    setRunning(false);
    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
      return;
    }
    setRunLabel(`Prune ${result.value.status}: ${result.value.pushed} delete(s).`);
    setRunProgress((prev) => ({
      ...prev,
      phase: result.value.status === "cancelled" ? "cancelled" : "done",
      pushed: result.value.pushed,
      failed: result.value.failed,
      itemCurrent: result.value.status === "cancelled" ? prev.itemCurrent : prev.itemTotal,
      endedAt: Date.now(),
      summaryMessage: `Prune ${result.value.status}: ${result.value.pushed} delete(s).`,
    }));
    if (result.value.status === "completed") {
      setPipelineProgress((prev) => ({ ...prev, pruneCompleted: true }));
    }
    activeRunActionRef.current = "";
    await refreshSettings();
  }, [activeProfile, ensureSessionToken, beginRun, refreshSettings]);

  const handleCancel = useCallback(async () => {
    await window.lockstep.cancelRun();
  }, []);

  const handlePickFolder = useCallback(async () => {
    const result = await window.lockstep.pickSourceFolder();
    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }
    if (result.value) {
      setProfileForm((current) => ({ ...current, sourceRoot: result.value ?? "" }));
    }
  }, []);

  const handleProfileChange = useCallback(async (profileId: string) => {
    const result = await window.lockstep.setActiveProfile(profileId);
    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }
    setSettings(result.value);
  }, []);

  return {
    session: {
      screen,
      setScreen,
      settings,
      activeProfile,
      error,
      sessionToken,
      setSessionToken,
      handleProfileChange,
    },
    profile: {
      profileForm,
      setProfileForm,
      handleCreateProfile,
      handlePickFolder,
    },
    plan: {
      plan,
      doctorResult,
      filter,
      setFilter,
      filteredItems,
      pipelineProgress,
      markReviewVisited,
    },
    run: {
      running,
      runLabel,
      logs,
      runProgress,
      handleDoctor,
      handlePlan,
      handlePush,
      handlePrune,
      handleCancel,
    },
  };
}
