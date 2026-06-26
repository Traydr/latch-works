import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../shared/types";
import { LayoutProvider } from "./layouts/LayoutContext";
import { LayoutRenderer } from "./layouts/LayoutRenderer";
import type { LayoutContentProps, Screen } from "./layouts/types";
import { useSystemTheme } from "./hooks/useSystemTheme";
import {
  applyRunEvent,
  emptyRunProgress,
  type RunProgressState,
} from "./utils/runProgress";

const emptyProfileForm = {
  apiUrl: "http://localhost:3000",
  name: "",
  sourceRoot: "",
  token: "",
};

export function App() {
  useSystemTheme();

  const [screen, setScreen] = useState<Screen>("dashboard");
  const [settings, setSettings] = useState<LockstepSettings | null>(null);
  const [profileForm, setProfileForm] = useState(emptyProfileForm);
  const [plan, setPlan] = useState<LockstepPlan | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("");
  const [runProgress, setRunProgress] = useState<RunProgressState>(emptyRunProgress);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState("");
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

  useEffect(() => {
    const unsubscribe = window.lockstep.onRunEvent((event: LockstepRunEvent) => {
      setRunProgress((current) => applyRunEvent(current, event));

      if (event.type === "status") {
        setRunLabel(event.message);
        setLogs((current) => [...current.slice(-200), event.message]);
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
        if (lastLoggedScanProgressRef.current !== logKey) {
          lastLoggedScanProgressRef.current = logKey;
          setLogs((current) => [...current.slice(-200), message]);
        }
      }

      if (event.type === "item-success") {
        const message = `[${event.current}/${event.total}] ${event.action} ${event.path}`;
        setRunLabel(message);
        setLogs((current) => [...current.slice(-200), message]);
      }

      if (event.type === "item-failure") {
        const message = `[${event.current}/${event.total}] failed ${event.path}: ${event.error}`;
        setRunLabel(message);
        setLogs((current) => [...current.slice(-200), message]);
      }

      if (event.type === "cancelled") {
        setRunLabel("Run cancelled.");
      }

      if (event.type === "complete") {
        setRunning(false);
        setRunLabel(event.summary.message ?? `${event.summary.action} ${event.summary.status}`);
        void refreshSettings();
      }
    });

    return unsubscribe;
  }, [refreshSettings]);

  const filteredItems = useMemo(() => {
    if (!plan) {
      return [];
    }

    const query = filter.trim().toLowerCase();
    return plan.items
      .filter((item) => item.action !== "keep")
      .filter((item) => !query || item.path.toLowerCase().includes(query));
  }, [filter, plan]);

  function resetRunState(initialMessage: string) {
    setRunning(true);
    setRunLabel(initialMessage);
    setRunProgress(emptyRunProgress());
    setLogs([initialMessage]);
    lastLoggedScanProgressRef.current = null;
  }

  async function handleCreateProfile(event: React.FormEvent) {
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
  }

  async function ensureSessionToken(profile: LockstepProfilePublic): Promise<boolean> {
    if (profile.tokenConfigured) {
      return true;
    }

    if (!sessionToken.trim()) {
      setError("Enter a sync API token for this session before running remote operations.");
      return false;
    }

    const result = await window.lockstep.updateProfile(profile.id, { token: sessionToken.trim() });
    if (Result.isError(result)) {
      setError(result.error.message);
      return false;
    }

    await refreshSettings();
    return true;
  }

  async function handleDoctor() {
    if (!activeProfile) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    setError(null);
    setDoctorResult(null);
    resetRunState("Running doctor...");
    setScreen("run");

    const result = await window.lockstep.doctor(activeProfile.id);
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setDoctorResult(result.value);
    setRunLabel(result.value.ok ? "Doctor passed." : "Doctor found issues.");
    setRunProgress((current) => ({
      ...current,
      stage: "complete",
      phaseLabel: result.value.ok ? "Doctor passed." : "Doctor found issues.",
    }));
    await refreshSettings();
  }

  async function handlePlan() {
    if (!activeProfile) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    setError(null);
    resetRunState("Planning sync...");
    setScreen("run");

    const result = await window.lockstep.plan({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setPlan(result.value);
    setScreen("plan");
    await refreshSettings();
  }

  async function handlePush() {
    if (!activeProfile) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    setError(null);
    resetRunState("Pushing uploads and updates...");
    setScreen("run");

    const result = await window.lockstep.push({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setRunLabel(`Push ${result.value.status}: ${result.value.pushed} item(s).`);
    setRunProgress((current) => ({
      ...current,
      stage: "complete",
      phaseLabel: `Push ${result.value.status}: ${result.value.pushed} item(s).`,
    }));
    await refreshSettings();
  }

  async function handlePrune() {
    if (!activeProfile) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    if (
      !window.confirm("Apply planned remote deletes? This cannot be undone from the desktop app.")
    ) {
      return;
    }

    setError(null);
    resetRunState("Applying remote deletes...");
    setScreen("run");

    const result = await window.lockstep.prune({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setRunLabel(`Prune ${result.value.status}: ${result.value.pushed} delete(s).`);
    setRunProgress((current) => ({
      ...current,
      stage: "complete",
      phaseLabel: `Prune ${result.value.status}: ${result.value.pushed} delete(s).`,
    }));
    await refreshSettings();
  }

  async function handleCancel() {
    await window.lockstep.cancelRun();
  }

  async function handlePickFolder() {
    const result = await window.lockstep.pickSourceFolder();
    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    if (result.value) {
      setProfileForm((current) => ({ ...current, sourceRoot: result.value ?? "" }));
    }
  }

  async function handleProfileChange(profileId: string) {
    const result = await window.lockstep.setActiveProfile(profileId);
    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setSettings(result.value);
  }

  const layoutProps: LayoutContentProps = {
    activeProfile,
    doctorResult,
    error,
    filter,
    filteredItems,
    handlers: {
      onBack: () => setScreen("dashboard"),
      onCancel: () => void handleCancel(),
      onCreateProfile: () => setScreen("profile"),
      onDoctor: () => void handleDoctor(),
      onFilterChange: setFilter,
      onPlan: () => void handlePlan(),
      onPrune: () => void handlePrune(),
      onProfileChange: (profileId) => void handleProfileChange(profileId),
      onPush: () => void handlePush(),
      onSessionTokenChange: setSessionToken,
      onViewActivity: () => setScreen("run"),
      onViewPlan: () => setScreen("plan"),
    },
    logs,
    plan,
    profileForm,
    runLabel,
    runProgress,
    running,
    screen,
    sessionToken,
    settings,
    onCancelProfile: () => setScreen("dashboard"),
    onPickFolder: () => void handlePickFolder(),
    onProfileFormChange: (patch) => setProfileForm((current) => ({ ...current, ...patch })),
    onSubmitProfile: (event) => void handleCreateProfile(event),
  };

  return (
    <LayoutProvider>
      <LayoutRenderer {...layoutProps} />
    </LayoutProvider>
  );
}
