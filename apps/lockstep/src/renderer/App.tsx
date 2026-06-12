import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../shared/types";
import { ActionDock } from "./components/ActionDock";
import { AlertBanner } from "./components/AlertBanner";
import { AppHeader } from "./components/AppHeader";
import { AppShell } from "./components/AppShell";
import { useSystemTheme } from "./hooks/useSystemTheme";
import { DashboardView } from "./views/DashboardView";
import { PlanResultsView } from "./views/PlanResultsView";
import { ProfileSetupView } from "./views/ProfileSetupView";
import { RunProgressView } from "./views/RunProgressView";
import { WelcomeView } from "./views/WelcomeView";

type Screen = "dashboard" | "plan" | "profile" | "run";

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
        setLogs((current) => [...current.slice(-200), message]);
      }

      if (event.type === "item-failure") {
        const message = `[${event.current}/${event.total}] failed ${event.path}: ${event.error}`;
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
    setRunning(true);
    setRunLabel("Running doctor...");
    setLogs(["Running doctor..."]);
    setScreen("run");

    const result = await window.lockstep.doctor(activeProfile.id);
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setDoctorResult(result.value);
    setRunLabel(result.value.ok ? "Doctor passed." : "Doctor found issues.");
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
    setRunning(true);
    setRunLabel("Planning sync...");
    setLogs(["Planning sync..."]);
    lastLoggedScanProgressRef.current = null;
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
    setRunning(true);
    setRunLabel("Pushing uploads and updates...");
    setLogs(["Pushing uploads and updates..."]);
    lastLoggedScanProgressRef.current = null;
    setScreen("run");

    const result = await window.lockstep.push({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setRunLabel(`Push ${result.value.status}: ${result.value.pushed} item(s).`);
    await refreshSettings();
  }

  async function handlePrune() {
    if (!activeProfile) {
      return;
    }

    if (!(await ensureSessionToken(activeProfile))) {
      return;
    }

    if (!window.confirm("Apply planned remote deletes? This cannot be undone from the desktop app.")) {
      return;
    }

    setError(null);
    setRunning(true);
    setRunLabel("Applying remote deletes...");
    setLogs(["Applying remote deletes..."]);
    lastLoggedScanProgressRef.current = null;
    setScreen("run");

    const result = await window.lockstep.prune({ profileId: activeProfile.id });
    setRunning(false);

    if (Result.isError(result)) {
      setError(result.error.message);
      return;
    }

    setRunLabel(`Prune ${result.value.status}: ${result.value.pushed} delete(s).`);
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

  const showActionDock = screen === "dashboard" && Boolean(activeProfile);

  return (
    <AppShell
      header={
        <AppHeader
          settings={settings}
          onAddProfile={() => setScreen("profile")}
          onProfileChange={(profileId) => void handleProfileChange(profileId)}
        />
      }
    >
      {error ? <AlertBanner message={error} /> : null}

      {screen === "profile" ? (
        <ProfileSetupView
          form={profileForm}
          onCancel={() => setScreen("dashboard")}
          onChange={(patch) => setProfileForm((current) => ({ ...current, ...patch }))}
          onPickFolder={() => void handlePickFolder()}
          onSubmit={(event) => void handleCreateProfile(event)}
        />
      ) : null}

      {screen === "dashboard" && activeProfile ? (
        <DashboardView
          plan={plan}
          profile={activeProfile}
          sessionToken={sessionToken}
          onSessionTokenChange={setSessionToken}
          onViewPlan={() => setScreen("plan")}
        />
      ) : null}

      {screen === "dashboard" && !activeProfile ? (
        <WelcomeView onCreateProfile={() => setScreen("profile")} />
      ) : null}

      {screen === "plan" && plan ? (
        <PlanResultsView
          filter={filter}
          items={filteredItems}
          plan={plan}
          onBack={() => setScreen("dashboard")}
          onFilterChange={setFilter}
        />
      ) : null}

      {screen === "run" ? (
        <RunProgressView
          doctorResult={doctorResult}
          logs={logs}
          running={running}
          runLabel={runLabel}
          onBack={() => setScreen("dashboard")}
          onCancel={() => void handleCancel()}
        />
      ) : null}

      {showActionDock ? (
        <ActionDock
          disabled={running}
          onDoctor={() => void handleDoctor()}
          onPlan={() => void handlePlan()}
          onPush={() => void handlePush()}
          onPrune={() => void handlePrune()}
        />
      ) : null}
    </AppShell>
  );
}
