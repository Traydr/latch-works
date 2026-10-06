import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  IpcErrorPayload,
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
import { appendSpan } from "../../lib/run-metrics";
import {
  emptyProfileForm,
  type ItemRunState,
  initialPipelineProgress,
  initialProgress,
  type LockstepController,
  type PipelineProgressState,
  type ProfileFormState,
  type RunKind,
  type RunProgressState,
  type Screen,
} from "./types";

export type {
  ItemRunState,
  LockstepController,
  PipelineProgressState,
  PlanController,
  ProfileController,
  ProfileFormState,
  RunController,
  RunKind,
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
  const [screen, setScreen] = useState<Screen>("workspace");
  const [settings, setSettings] = useState<LockstepSettings | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileFormState>(emptyProfileForm);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [plan, setPlan] = useState<LockstepPlan | null>(null);
  const [plannedAt, setPlannedAt] = useState<number | null>(null);
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
  const itemStatesRef = useRef(new Map<string, ItemRunState>());
  /** When each in-flight item started, so its bytes can be spread over its transfer time. */
  const itemStartedAtRef = useRef(new Map<string, number>());
  const [itemStatesVersion, setItemStatesVersion] = useState(0);

  const setItemState = useCallback((path: string, state: ItemRunState) => {
    itemStatesRef.current.set(path, state);
    setItemStatesVersion((version) => version + 1);
  }, []);

  const clearItemStates = useCallback(() => {
    itemStatesRef.current = new Map();
    itemStartedAtRef.current = new Map();
    setItemStatesVersion((version) => version + 1);
  }, []);

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

      if (event.type === "items-queued") {
        const at = Date.now();
        clearItemStates();
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemTotal: event.total,
          bytesTotal: event.totalBytes,
          bytesDone: 0,
          bytesFailed: 0,
          queuedAt: at,
          spans: [],
          failureTimes: [],
        }));
      }

      if (event.type === "item-start") {
        itemStartedAtRef.current.set(event.path, Date.now());
        setItemState(event.path, { type: "active" });
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: event.action,
        }));
      }

      if (event.type === "item-success") {
        const message = `[${event.current}/${event.total}] ${event.action} ${event.path}`;
        const to = Date.now();
        const from = itemStartedAtRef.current.get(event.path) ?? to;
        const bytes = event.bytes ?? 0;
        itemStartedAtRef.current.delete(event.path);
        setLogs((current) => [...current.slice(-200), message]);
        setItemState(event.path, { type: "done" });
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: event.action,
          pushed: prev.pushed + 1,
          bytesDone: prev.bytesDone + bytes,
          spans: bytes > 0 ? appendSpan(prev.spans, { from, to, bytes }) : prev.spans,
        }));
      }

      if (event.type === "item-skipped") {
        const message = `[${event.current}/${event.total}] skipped ${event.path}: ${event.reason}`;
        setLogs((current) => [...current.slice(-200), message]);
        setItemState(event.path, { type: "skipped", reason: event.reason });
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: "skip",
          skipped: prev.skipped + 1,
        }));
      }

      if (event.type === "item-failure") {
        const message = `[${event.current}/${event.total}] failed ${event.path}: ${event.error}`;
        setLogs((current) => [...current.slice(-200), message]);
        setItemState(event.path, { type: "failed", error: event.error });
        setRunProgress((prev) => ({
          ...prev,
          phase: "items",
          itemCurrent: event.current,
          itemTotal: event.total,
          currentPath: event.path,
          currentAction: event.action,
          failed: prev.failed + 1,
          bytesFailed: prev.bytesFailed + (event.bytes ?? 0),
          failureTimes: [...prev.failureTimes.slice(-500), Date.now()],
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
    [clearItemStates, refreshSettings, setItemState],
  );

  useEffect(() => {
    const unsubscribe = requireLockstepApi().onRunEvent(applyRunEvent);

    return unsubscribe;
  }, [applyRunEvent]);

  // A window opened while the main process is still running something (macOS keeps the app alive
  // after its window closes) shows that run and its Cancel button until the run completes.
  useEffect(() => {
    void (async () => {
      const result = await requireLockstepApi().getRunStatus();

      if (Result.isError(result) || !result.value) {
        return;
      }

      const { action } = result.value;
      const label = `Resumed the ${action} run in progress...`;
      setRunning(true);
      activeRunActionRef.current = action;
      setRunLabel(label);
      setLogs([label]);
      setRunProgress({
        ...initialProgress,
        phase: "items",
        kind: action,
        action,
        startedAt: Date.now(),
      });
    })();
  }, []);

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
    () =>
      getPruneAvailability({
        plan,
        prunedPlanId,
        pushCompleted: pipelineProgress.pushCompleted,
      }),
    [plan, prunedPlanId, pipelineProgress.pushCompleted],
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

  const beginRun = useCallback(
    (label: string, kind: Exclude<RunKind, "">) => {
      setError(null);
      setRunning(true);
      activeRunActionRef.current = kind;
      setRunLabel(label);
      setLogs([label]);
      lastLoggedScanProgressRef.current = null;
      clearItemStates();
      setRunProgress({
        ...initialProgress,
        phase: "planning",
        kind,
        action: kind,
        startedAt: Date.now(),
      });
    },
    [clearItemStates],
  );

  /** Ends a run whose request failed. A cancelled run keeps the progress it reached. */
  const endRunWithError = useCallback((failure: IpcErrorPayload) => {
    if (failure._tag === "RunCancelled") {
      setRunLabel("Run cancelled.");
      setRunProgress((prev) => ({
        ...prev,
        phase: "cancelled",
        endedAt: prev.endedAt ?? Date.now(),
      }));

      return;
    }

    setError(failure.message);
    setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
  }, []);

  const dismissDoctorResult = useCallback(() => setDoctorResult(null), []);

  /** Drops the plan and doctor result, which describe one profile's source folder and server. */
  const clearPlanState = useCallback(() => {
    setPlan(null);
    setPlannedAt(null);
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
      clearItemStates();
    }
  }, [clearItemStates, clearPlanState, running]);

  const closeProfileForm = useCallback(() => {
    setEditingProfileId(null);
    setProfileForm(emptyProfileForm);
    setScreen("workspace");
  }, []);

  const startCreateProfile = useCallback(() => {
    // Keep a half-typed new profile across visits, but never carry an edited profile's values over.
    if (editingProfileId) {
      setProfileForm(emptyProfileForm);
    }

    setEditingProfileId(null);
    setScreen("profile");
  }, [editingProfileId]);

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
    [running, settings],
  );

  const cancelProfileForm = useCallback(() => {
    if (editingProfileId) {
      closeProfileForm();

      return;
    }

    setScreen("workspace");
  }, [closeProfileForm, editingProfileId]);

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
      endRunWithError(result.error);

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
  }, [activeProfile, ensureSessionToken, beginRun, endRunWithError, refreshSettings]);

  const handlePlan = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return false;
    }

    beginRun("Planning sync...", "plan");
    const result = await requireLockstepApi().plan({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      endRunWithError(result.error);

      return false;
    }

    setPlan(result.value);
    setPlannedAt(Date.now());
    setPipelineProgress(initialPipelineProgress);
    setRunProgress((prev) => ({ ...prev, phase: "done", endedAt: Date.now() }));
    await refreshSettings();

    return true;
  }, [activeProfile, ensureSessionToken, beginRun, endRunWithError, refreshSettings]);

  const handlePush = useCallback(async () => {
    if (!activeProfile || !(await ensureSessionToken(activeProfile))) {
      return;
    }

    beginRun("Pushing uploads and updates...", "push");
    const result = await requireLockstepApi().push({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      endRunWithError(result.error);

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
  }, [activeProfile, ensureSessionToken, beginRun, endRunWithError, refreshSettings]);

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
    const result = await requireLockstepApi().prune({ planId, profileId: activeProfile.id });
    setRunning(false);
    // The main process uses a plan for one Prune only, whatever the outcome.
    setPrunedPlanId(planId);

    if (Result.isError(result)) {
      endRunWithError(result.error);

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
  }, [
    activeProfile,
    plan,
    pruneAvailability,
    ensureSessionToken,
    beginRun,
    endRunWithError,
    refreshSettings,
  ]);

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
      // A run's reply describes the profile it started with, so the selection waits for it.
      if (running) {
        return;
      }

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
    [resetForActiveProfileChange, running, settings],
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
      plannedAt,
      doctorResult,
      dismissDoctorResult,
      filter,
      setFilter,
      filteredItems,
      pipelineProgress,
      pruneAvailability,
    },
    run: {
      running,
      runLabel,
      logs,
      runProgress,
      itemStates: itemStatesRef.current,
      itemStatesVersion,
      handleDoctor,
      handlePlan,
      handlePush,
      handlePrune,
      handleCancel,
    },
  };
}
