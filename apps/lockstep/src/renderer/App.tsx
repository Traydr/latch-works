import { Result } from "better-result";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DoctorResult,
  LockstepPlan,
  LockstepProfilePublic,
  LockstepRunEvent,
  LockstepSettings,
} from "../shared/types";
type Screen = "dashboard" | "plan" | "profile" | "run";

const emptyProfileForm = {
  apiUrl: "http://localhost:3000",
  name: "",
  sourceRoot: "",
  token: "",
};

function tokenStatusLabel(configured: boolean): string {
  return configured ? "Configured (encrypted or current session)" : "Not configured";
}

function actionBadgeClass(action: string): string {
  switch (action) {
    case "upload":
      return "badge badge-upload";
    case "update":
      return "badge badge-update";
    case "delete":
      return "badge badge-delete";
    default:
      return "badge badge-keep";
  }
}

export function App() {
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
        setRunLabel(message);
        setLogs((current) => [...current.slice(-200), message]);
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

  function renderProfileSummary(profile: LockstepProfilePublic) {
    return (
      <div className="grid-2">
        <div>
          <div className="muted">Source</div>
          <div>{profile.sourceRoot}</div>
        </div>
        <div>
          <div className="muted">API URL</div>
          <div>{profile.apiUrl}</div>
        </div>
        <div>
          <div className="muted">Token</div>
          <div>{tokenStatusLabel(profile.tokenConfigured)}</div>
        </div>
        <div>
          <div className="muted">Last run</div>
          <div>
            {profile.lastRun
              ? `${profile.lastRun.action} · ${profile.lastRun.status} · ${new Date(profile.lastRun.completedAt).toLocaleString()}`
              : "None"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Lockstep</h1>
        <div className="actions">
          {settings && settings.profiles.length > 0 ? (
            <select
              value={settings.activeProfileId ?? ""}
              onChange={(event) => void handleProfileChange(event.target.value)}
            >
              {settings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          ) : null}
          <button className="btn btn-secondary" type="button" onClick={() => setScreen("profile")}>
            {settings?.profiles.length ? "Add profile" : "Create profile"}
          </button>
        </div>
      </header>

      <main className="app-main">
        {error ? <div className="warning">{error}</div> : null}

        {screen === "profile" ? (
          <section className="panel">
            <h2>Profile setup</h2>
            <form className="grid-2" onSubmit={(event) => void handleCreateProfile(event)}>
              <div className="field">
                <label htmlFor="profile-name">Profile name</label>
                <input
                  id="profile-name"
                  value={profileForm.name}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, name: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="profile-api-url">Pane View API URL</label>
                <input
                  id="profile-api-url"
                  value={profileForm.apiUrl}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, apiUrl: event.target.value }))
                  }
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="profile-source">Source folder</label>
                <div className="actions">
                  <input
                    id="profile-source"
                    value={profileForm.sourceRoot}
                    onChange={(event) =>
                      setProfileForm((current) => ({ ...current, sourceRoot: event.target.value }))
                    }
                    required
                  />
                  <button className="btn btn-secondary" type="button" onClick={() => void handlePickFolder()}>
                    Browse
                  </button>
                </div>
              </div>
              <div className="field">
                <label htmlFor="profile-token">Sync API token</label>
                <input
                  id="profile-token"
                  type="password"
                  value={profileForm.token}
                  onChange={(event) =>
                    setProfileForm((current) => ({ ...current, token: event.target.value }))
                  }
                  placeholder="Saved with OS encryption when available"
                />
              </div>
              <div className="actions">
                <button className="btn btn-primary" type="submit">
                  Save profile
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => setScreen("dashboard")}>
                  Cancel
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {screen === "dashboard" && activeProfile ? (
          <>
            <section className="panel">
              <h2>Dashboard</h2>
              {renderProfileSummary(activeProfile)}
              {!activeProfile.tokenConfigured ? (
                <div className="field" style={{ marginTop: "1rem" }}>
                  <label htmlFor="session-token">Session sync token</label>
                  <input
                    id="session-token"
                    type="password"
                    value={sessionToken}
                    onChange={(event) => setSessionToken(event.target.value)}
                    placeholder="local-lockstep-sync-token"
                  />
                </div>
              ) : null}
              <div className="actions" style={{ marginTop: "1rem" }}>
                <button className="btn btn-secondary" type="button" disabled={running} onClick={() => void handleDoctor()}>
                  Test connection
                </button>
                <button className="btn btn-primary" type="button" disabled={running} onClick={() => void handlePlan()}>
                  Plan
                </button>
                <button className="btn btn-primary" type="button" disabled={running} onClick={() => void handlePush()}>
                  Push uploads/updates
                </button>
                <button className="btn btn-danger" type="button" disabled={running} onClick={() => void handlePrune()}>
                  Apply deletes
                </button>
              </div>
            </section>

            {plan ? (
              <section className="panel">
                <h2>Latest plan</h2>
                <div className="stats">
                  <div className="stat-card">
                    <strong>{plan.counts.upload}</strong>
                    upload
                  </div>
                  <div className="stat-card">
                    <strong>{plan.counts.update}</strong>
                    update
                  </div>
                  <div className="stat-card">
                    <strong>{plan.counts.keep}</strong>
                    keep
                  </div>
                  <div className="stat-card">
                    <strong>{plan.counts.delete}</strong>
                    delete
                  </div>
                </div>
                <p className="muted">Skipped files: {plan.skipped}</p>
                <button className="btn btn-secondary" type="button" onClick={() => setScreen("plan")}>
                  View plan details
                </button>
              </section>
            ) : null}
          </>
        ) : null}

        {screen === "dashboard" && !activeProfile ? (
          <section className="panel">
            <h2>Welcome</h2>
            <p>Create a profile with your local archive folder, Pane View API URL, and sync token.</p>
            <button className="btn btn-primary" type="button" onClick={() => setScreen("profile")}>
              Create your first profile
            </button>
          </section>
        ) : null}

        {screen === "plan" && plan ? (
          <section className="panel">
            <h2>Plan results</h2>
            <div className="stats">
              <div className="stat-card">
                <strong>{plan.counts.upload}</strong>
                upload
              </div>
              <div className="stat-card">
                <strong>{plan.counts.update}</strong>
                update
              </div>
              <div className="stat-card">
                <strong>{plan.counts.delete}</strong>
                delete
              </div>
            </div>
            {plan.counts.delete > 0 ? (
              <div className="warning" style={{ marginTop: "1rem" }}>
                {plan.counts.delete} remote delete(s) are planned. Push will not apply them; use Apply deletes
                separately after review.
              </div>
            ) : null}
            <div className="field" style={{ marginTop: "1rem" }}>
              <label htmlFor="plan-filter">Filter changed items</label>
              <input
                id="plan-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search by path"
              />
            </div>
            <div className="item-list">
              {filteredItems.map((item) => (
                <div key={`${item.action}:${item.path}`} className="item-row">
                  <span className={actionBadgeClass(item.action)}>{item.action}</span>
                  <span>{item.path}</span>
                </div>
              ))}
            </div>
            <div className="actions" style={{ marginTop: "1rem" }}>
              <button className="btn btn-secondary" type="button" onClick={() => setScreen("dashboard")}>
                Back to dashboard
              </button>
            </div>
          </section>
        ) : null}

        {screen === "run" ? (
          <section className="panel">
            <h2>Run progress</h2>
            <p>{runLabel || "Working..."}</p>
            {doctorResult ? (
              <div className="grid-2" style={{ marginBottom: "1rem" }}>
                {doctorResult.checks.map((check) => (
                  <div key={check.label}>
                    <div className="muted">{check.label}</div>
                    <div>
                      {check.ok ? "ok" : "failed"}
                      {check.detail ? ` · ${check.detail}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="log">{logs.join("\n")}</div>
            <div className="actions" style={{ marginTop: "1rem" }}>
              <button className="btn btn-secondary" type="button" disabled={!running} onClick={() => void handleCancel()}>
                Cancel
              </button>
              <button className="btn btn-primary" type="button" onClick={() => setScreen("dashboard")}>
                Back to dashboard
              </button>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
