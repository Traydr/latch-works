import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../../shared/types";

export type Screen = "dashboard" | "plan" | "profile" | "run";

export type RunPhase =
  | "idle"
  | "planning"
  | "scanning"
  | "hashing"
  | "items"
  | "done"
  | "cancelled"
  | "error";

export interface RunProgressState {
  phase: RunPhase;
  action: string;
  itemCurrent: number;
  itemTotal: number;
  scanFilesFound: number;
  scanSkipped: number;
  bytesHashed: number;
  fileSize: number | null;
  scanPath: string | null;
  scanStage: "scanning" | "hashing" | null;
  currentPath: string | null;
  currentAction: string | null;
  failed: number;
  pushed: number;
  startedAt: number | null;
  endedAt: number | null;
  summaryMessage: string | null;
}

const initialProgress: RunProgressState = {
  phase: "idle",
  action: "",
  itemCurrent: 0,
  itemTotal: 0,
  scanFilesFound: 0,
  scanSkipped: 0,
  bytesHashed: 0,
  fileSize: null,
  scanPath: null,
  scanStage: null,
  currentPath: null,
  currentAction: null,
  failed: 0,
  pushed: 0,
  startedAt: null,
  endedAt: null,
  summaryMessage: null,
};

const emptyProfileForm = {
  apiUrl: "http://localhost:3000",
  name: "",
  sourceRoot: "",
  token: "",
};

export interface LockstepController {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  settings: LockstepSettings | null;
  activeProfile: LockstepProfilePublic | null;
  profileForm: typeof emptyProfileForm;
  setProfileForm: React.Dispatch<React.SetStateAction<typeof emptyProfileForm>>;
  plan: LockstepPlan | null;
  doctorResult: DoctorResult | null;
  filter: string;
  setFilter: (value: string) => void;
  filteredItems: Array<{ action: string; path: string }>;
  running: boolean;
  runLabel: string;
  logs: string[];
  error: string | null;
  sessionToken: string;
  setSessionToken: (value: string) => void;
  runProgress: RunProgressState;
  handleCreateProfile: (event: React.FormEvent) => Promise<void>;
  handleDoctor: () => Promise<void>;
  handlePlan: () => Promise<void>;
  handlePush: () => Promise<void>;
  handlePrune: () => Promise<void>;
  handleCancel: () => Promise<void>;
  handlePickFolder: () => Promise<void>;
  handleProfileChange: (profileId: string) => Promise<void>;
}

export function useLockstepController(): LockstepController {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [settings, setSettings] = useState<LockstepSettings | null>(null);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [plan, setPlan] = useState<LockstepPlan | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState("");
  const [runProgress, setRunProgress] = useState<RunProgressState>(initialProgress);
  const lastLoggedScanProgressRef = useRef<string | null>(null);

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
        setRunning(false);
        setRunLabel(event.summary.message ?? `${event.summary.action} ${event.summary.status}`);
        setRunProgress((prev) => ({
          ...prev,
          phase: event.summary.status === "cancelled" ? "cancelled" : "done",
          itemCurrent: event.summary.status === "cancelled" ? prev.itemCurrent : prev.itemTotal,
          failed: event.summary.failed,
          pushed: event.summary.pushed,
          endedAt: Date.now(),
          summaryMessage: event.summary.message ?? null,
        }));
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
    return plan.items
      .filter((item) => item.action !== "keep")
      .filter((item) => !query || item.path.toLowerCase().includes(query));
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
    setRunLabel(label);
    setLogs([label]);
    lastLoggedScanProgressRef.current = null;
    setRunProgress({ ...initialProgress, phase: "planning", action, startedAt: Date.now() });
    setScreen("run");
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
    [profileForm, refreshSettings],
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
      return;
    }
    beginRun("Planning sync...", "plan");
    const result = await window.lockstep.plan({ profileId: activeProfile.id });
    setRunning(false);
    if (Result.isError(result)) {
      setError(result.error.message);
      setRunProgress((prev) => ({ ...prev, phase: "error", endedAt: Date.now() }));
      return;
    }
    setPlan(result.value);
    setScreen("plan");
    setRunProgress((prev) => ({ ...prev, phase: "done", endedAt: Date.now() }));
    await refreshSettings();
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
    screen,
    setScreen,
    settings,
    activeProfile,
    profileForm,
    setProfileForm,
    plan,
    doctorResult,
    filter,
    setFilter,
    filteredItems,
    running,
    runLabel,
    logs,
    error,
    sessionToken,
    setSessionToken,
    runProgress,
    handleCreateProfile,
    handleDoctor,
    handlePlan,
    handlePush,
    handlePrune,
    handleCancel,
    handlePickFolder,
    handleProfileChange,
  };
}
