import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfileInput,
  LockstepProfilePatch,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../../../shared/types";
import { requireLockstepApi } from "../../lib/bridge";
import {
  describeRemoteEntries,
  pruneAvailability as getPruneAvailability,
  shouldEndRunOnComplete,
} from "../../lib/run-lifecycle";
import {
  emptyProfileForm,
  initialPipelineProgress,
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
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [plan, setPlan] = useState<LockstepPlan | null>(null);
  /** The plan whose deletes went to Prune; the main process has already discarded it. */
  const [prunedPlanId, setPrunedPlanId] = useState<string | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [runProgress, setRunProgress] = useState<RunProgressState>(initialProgress);

  const [pipelineProgress, setPipelineProgress] =
    useState<PipelineProgressState>(initialPipelineProgress);

  const lastLoggedScanProgressRef = useRef<string | null>(null);
  const activeRunActionRef = useRef("");

  const activeProfile = useMemo(() => {
    if (!settings?.activeProfileId) {
      return null;
    }

    return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? null;
  }, [settings]);

  const editingProfile = useMemo(() => {
    if (!editingProfileId) {
      return null;
    }

    return settings?.profiles.find((profile) => profile.id === editingProfileId) ?? null;
  }, [editingProfileId, settings]);

  const refreshSettings = useCallback(async () => {
    const result = await requireLockstepApi().getSettings();

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

      if (event.type === "item-skipped") {
        const message = `[${event.current}/${event.total}] skipped ${event.path}: ${event.reason}`;
        setLogs((current) => [...current.slice(-200), message]);
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: "skip",
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
    const unsubscribe = requireLockstepApi().onRunEvent(applyRunEvent);

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

  const pruneAvailability = useMemo(
    () => getPruneAvailability(plan, prunedPlanId),
    [plan, prunedPlanId],
  );

  const ensureSessionToken = useCallback(
    async (profile: LockstepProfilePublic): Promise<boolean> => {
      if (profile.tokenConfigured) {
        return true;
      }

      if (!sessionToken.trim()) {
        setError("Enter a sync API token for this profile before running remote operations.");

        return false;
      }

      const result = await requireLockstepApi().updateProfile(profile.id, {
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

  /** Drops the plan and doctor result, which describe one profile's source folder and server. */
  const clearPlanState = useCallback(() => {
    setPlan(null);
    setDoctorResult(null);
    setFilter("");
    setPipelineProgress(initialPipelineProgress);
  }, []);

  /** Another profile became active: nothing on screen may describe the previous one. */
  const resetForActiveProfileChange = useCallback(() => {
    clearPlanState();
    setSessionToken("");

    if (!running) {
      setLogs([]);
      setRunLabel("");
      setRunProgress(initialProgress);
    }
  }, [clearPlanState, running]);

  const closeProfileForm = useCallback(() => {
    setEditingProfileId(null);
    setProfileForm(emptyProfileForm);
    setScreen("dashboard");
  }, [setScreen]);

  const startCreateProfile = useCallback(() => {
    // Keep a half-typed new profile across visits, but never carry an edited profile's values over.
    if (editingProfileId) {
      setProfileForm(emptyProfileForm);
    }

    setEditingProfileId(null);
    setScreen("profile");
  }, [editingProfileId, setScreen]);

  const startEditProfile = useCallback(
    (profileId: string) => {
      const target = settings?.profiles.find((profile) => profile.id === profileId);

      if (!target || running) {
        return;
      }

      setError(null);
      setProfileForm({
        apiUrl: target.apiUrl,
        clearToken: false,
        name: target.name,
        sourceRoot: target.sourceRoot,
        token: "",
      });
      setEditingProfileId(profileId);
      setScreen("profile");
    },
    [running, settings, setScreen],
  );

  const cancelProfileForm = useCallback(() => {
    if (editingProfileId) {
      closeProfileForm();

      return;
    }

    setScreen("dashboard");
  }, [closeProfileForm, editingProfileId, setScreen]);

  const submitEditedProfile = useCallback(
    async (profileId: string) => {
      const previous = settings?.profiles.find((profile) => profile.id === profileId);
      const token = profileForm.token.trim();

      const patch: LockstepProfilePatch = {
        apiUrl: profileForm.apiUrl,
        name: profileForm.name,
        sourceRoot: profileForm.sourceRoot,
      };

      if (token) {
        patch.token = token;
      } else if (profileForm.clearToken) {
        patch.clearToken = true;
      }

      const result = await requireLockstepApi().updateProfile(profileId, patch);

      if (Result.isError(result)) {
        setError(result.error.message);

        return false;
      }

      if (profileId === settings?.activeProfileId) {
        const targetMoved =
          result.value.apiUrl !== previous?.apiUrl ||
          result.value.sourceRoot !== previous?.sourceRoot;

        if (targetMoved) {
          clearPlanState();
        }

        if (patch.token || patch.clearToken) {
          setSessionToken("");
        }
      }

      return true;
    },
    [clearPlanState, profileForm, settings],
  );

  const submitNewProfile = useCallback(async () => {
    const token = profileForm.token.trim();

    const input: LockstepProfileInput = {
      apiUrl: profileForm.apiUrl,
      name: profileForm.name,
      sourceRoot: profileForm.sourceRoot,
    };

    if (token) {
      input.token = token;
    }

    const result = await requireLockstepApi().createProfile(input);

    if (Result.isError(result)) {
      setError(result.error.message);

      return false;
    }

    return true;
  }, [profileForm]);

  const handleSubmitProfile = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);

      const saved = editingProfileId
        ? await submitEditedProfile(editingProfileId)
        : await submitNewProfile();

      if (!saved) {
        return;
      }

      await refreshSettings();
      closeProfileForm();
    },
    [closeProfileForm, editingProfileId, refreshSettings, submitEditedProfile, submitNewProfile],
  );

  const handleDeleteProfile = useCallback(
    async (profileId: string) => {
      const target = settings?.profiles.find((profile) => profile.id === profileId);

      if (!target || running) {
        return;
      }

      if (
        !window.confirm(
          `Delete the profile "${target.name}"? Its saved sync token is removed from this computer. Files in the source folder and on Pane View are not touched.`,
        )
      ) {
        return;
      }

      setError(null);
      const result = await requireLockstepApi().deleteProfile(profileId);

      if (Result.isError(result)) {
        setError(result.error.message);

        return;
      }

      setSettings(result.value);

      if (profileId === settings?.activeProfileId) {
        resetForActiveProfileChange();
      }

      if (profileId === editingProfileId) {
        closeProfileForm();
      }
    },
    [closeProfileForm, editingProfileId, resetForActiveProfileChange, running, settings],
  );

  const handleDoctor = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return;
    }

    setDoctorResult(null);
    beginRun("Running doctor...", "doctor");
    const result = await requireLockstepApi().doctor(activeProfile.id);
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
    const result = await requireLockstepApi().plan({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));

      return false;
    }

    setPlan(result.value);
    setPipelineProgress({ ...initialPipelineProgress, reviewed: true });
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
    const result = await requireLockstepApi().push({ profileId: activeProfile.id });
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
    if (!activeProfile || !plan || !pruneAvailability.enabled) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    if (
      !window.confirm(
        `Delete ${describeRemoteEntries(pruneAvailability.deleteCount)} from ${activeProfile.apiUrl}? These are the deletes in the plan you reviewed; any whose file is back in the source folder is skipped. This cannot be undone from the desktop app.`,
      )
    ) {
      return;
    }

    const planId = plan.planId;
    beginRun("Applying remote deletes...", "prune");
    setRunProgress((prev) => ({ ...prev, phase: "items", action: "prune" }));
    const result = await requireLockstepApi().prune({ planId, profileId: activeProfile.id });
    setRunning(false);
    // The main process uses a plan for one Prune only, whatever the outcome.
    setPrunedPlanId(planId);

    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));

      return;
    }

    const skipped = result.value.skipped ?? 0;
    const skippedNote = skipped > 0 ? `, ${skipped} skipped (back in the source folder)` : "";
    const label = `Prune ${result.value.status}: ${result.value.pushed} deleted${skippedNote}.`;
    setRunLabel(label);
    setRunProgress((prev) => ({
      ...prev,
      phase: result.value.status === "cancelled" ? "cancelled" : "done",
      pushed: result.value.pushed,
      failed: result.value.failed,
      itemCurrent: result.value.status === "cancelled" ? prev.itemCurrent : prev.itemTotal,
      endedAt: Date.now(),
      summaryMessage: label,
    }));

    if (result.value.status === "completed") {
      setPipelineProgress((prev) => ({ ...prev, pruneCompleted: true }));
    }

    activeRunActionRef.current = "";
    await refreshSettings();
  }, [activeProfile, plan, pruneAvailability, ensureSessionToken, beginRun, refreshSettings]);

  const handleCancel = useCallback(async () => {
    await requireLockstepApi().cancelRun();
  }, []);

  const handlePickFolder = useCallback(async () => {
    const result = await requireLockstepApi().pickSourceFolder();

    if (Result.isError(result)) {
      setError(result.error.message);

      return;
    }

    if (result.value) {
      setProfileForm((current) => ({ ...current, sourceRoot: result.value ?? "" }));
    }
  }, []);

  const handleProfileChange = useCallback(
    async (profileId: string) => {
      const result = await requireLockstepApi().setActiveProfile(profileId);

      if (Result.isError(result)) {
        setError(result.error.message);

        return;
      }

      if (profileId !== settings?.activeProfileId) {
        resetForActiveProfileChange();
      }

      setSettings(result.value);
    },
    [resetForActiveProfileChange, settings],
  );

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
      editingProfile,
      startCreateProfile,
      startEditProfile,
      cancelProfileForm,
      handleSubmitProfile,
      handleDeleteProfile,
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
      pruneAvailability,
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
