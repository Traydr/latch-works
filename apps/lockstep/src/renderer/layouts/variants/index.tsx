import type { ReactNode } from "react";

import { AlertBanner } from "../../components/AlertBanner";
import { AppHeader } from "../../components/AppHeader";
import { PlanCountGrid } from "../../components/PlanCountGrid";
import { ProfileSelect } from "../../components/ProfileSelect";
import { RunProgressPanel } from "../../components/progress/RunProgressPanel";
import { ProfileSetupView } from "../../views/ProfileSetupView";
import { WelcomeView } from "../../views/WelcomeView";
import { CompactPlanList } from "../shared/CompactPlanList";
import { LayoutActionButtons } from "../shared/LayoutActionButtons";
import { ProfileHealthStrip } from "../shared/ProfileHealthStrip";
import type { LayoutProps } from "../types";

function TokenField({
  profile,
  sessionToken,
  onSessionTokenChange,
}: {
  profile: NonNullable<LayoutProps["activeProfile"]>;
  sessionToken: string;
  onSessionTokenChange: (value: string) => void;
}) {
  if (profile.tokenConfigured) {
    return null;
  }

  return (
    <label className="grid gap-1">
      <span className="prism-label">Sync API token</span>
      <input
        className="prism-input py-1.5 text-xs"
        type="password"
        value={sessionToken}
        onChange={(event) => onSessionTokenChange(event.target.value)}
        placeholder="Enter token for this session"
      />
    </label>
  );
}

function ScreenContent(props: LayoutProps) {
  const {
    activeProfile,
    doctorResult,
    error,
    filter,
    filteredItems,
    handlers,
    logs,
    plan,
    profileForm,
    runLabel,
    runProgress,
    running,
    screen,
    sessionToken,
    onCancelProfile,
    onPickFolder,
    onProfileFormChange,
    onSubmitProfile,
  } = props;

  if (screen === "profile") {
    return (
      <ProfileSetupView
        form={profileForm}
        onCancel={onCancelProfile}
        onChange={onProfileFormChange}
        onPickFolder={onPickFolder}
        onSubmit={onSubmitProfile}
      />
    );
  }

  if (!activeProfile) {
    return <WelcomeView onCreateProfile={handlers.onCreateProfile} />;
  }

  if (screen === "run") {
    return (
      <RunProgressPanel
        doctorResult={doctorResult}
        logs={logs}
        onBack={handlers.onBack}
        onCancel={handlers.onCancel}
        progress={runProgress}
        running={running}
        runLabel={runLabel}
      />
    );
  }

  if (screen === "plan" && plan) {
    return (
      <div className="prism-section">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Plan results</h2>
            <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {filteredItems.length.toLocaleString()} changed item(s)
            </p>
          </div>
          <button className="prism-btn" type="button" onClick={handlers.onBack}>
            Back
          </button>
        </div>
        <PlanCountGrid compact counts={plan.counts} />
        {plan.counts.delete > 0 ? (
          <div className="mt-3">
            <AlertBanner
              variant="warning"
              message={`${plan.counts.delete} remote delete(s) planned. Push will not apply them.`}
            />
          </div>
        ) : null}
        <div className="mt-3">
          <CompactPlanList
            filter={filter}
            items={filteredItems}
            onFilterChange={handlers.onFilterChange}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="prism-section">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Dashboard</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{activeProfile.name}</p>
        </div>
      </div>
      <ProfileHealthStrip profile={activeProfile} />
      <div className="mt-3">
        <TokenField
          profile={activeProfile}
          sessionToken={sessionToken}
          onSessionTokenChange={handlers.onSessionTokenChange}
        />
      </div>
      {plan ? (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Latest plan</h3>
            <button className="prism-btn" type="button" onClick={handlers.onViewPlan}>
              View details
            </button>
          </div>
          <PlanCountGrid compact counts={plan.counts} />
        </div>
      ) : null}
    </div>
  );
}

function SidebarShell({ children, header }: { children: ReactNode; header: ReactNode }) {
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-zinc-50 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="shrink-0 border-b border-zinc-200/80 px-4 py-3 dark:border-zinc-800/80">{header}</div>
      {children}
    </div>
  );
}

export function SidebarCommandLayout(props: LayoutProps) {
  const { activeProfile, handlers, running, settings } = props;

  return (
    <SidebarShell
      header={
        <AppHeader
          settings={settings}
          onAddProfile={handlers.onCreateProfile}
          onProfileChange={handlers.onProfileChange}
        />
      }
    >
      <div className="flex min-h-0 flex-1">
        {activeProfile ? (
          <aside className="flex w-60 shrink-0 flex-col gap-3 border-r border-zinc-200/80 bg-white/40 p-3 dark:border-zinc-800/80 dark:bg-zinc-900/30">
            <div>
              <p className="prism-label mb-1">Active profile</p>
              {settings ? (
                <ProfileSelect
                  profiles={settings.profiles}
                  value={settings.activeProfileId ?? ""}
                  onChange={handlers.onProfileChange}
                />
              ) : null}
            </div>
            <ProfileHealthStrip compact profile={activeProfile} />
            <div className="mt-auto">
              <p className="prism-label mb-2">Actions</p>
              <LayoutActionButtons
                disabled={running}
                layout="vertical"
                onDoctor={handlers.onDoctor}
                onPlan={handlers.onPlan}
                onPrune={handlers.onPrune}
                onPush={handlers.onPush}
              />
            </div>
          </aside>
        ) : null}
        <main className="min-w-0 flex-1 overflow-auto p-4">
          {props.error ? <AlertBanner message={props.error} /> : null}
          <ScreenContent {...props} />
        </main>
      </div>
    </SidebarShell>
  );
}

export function SplitWorkspaceLayout(props: LayoutProps) {
  const { activeProfile, doctorResult, error, filter, filteredItems, handlers, logs, plan, runLabel, runProgress, running, screen, settings } = props;
  const showRunPane = screen === "run" || running;

  return (
    <SidebarShell
      header={
        <AppHeader
          settings={settings}
          onAddProfile={handlers.onCreateProfile}
          onProfileChange={handlers.onProfileChange}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {error ? <AlertBanner message={error} /> : null}
        {!activeProfile ? (
          <ScreenContent {...props} />
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[45%_55%]">
            <section className="flex min-h-0 flex-col prism-section">
              <div className="mb-3">
                <h2 className="text-sm font-semibold">{activeProfile.name}</h2>
                <ProfileHealthStrip compact profile={activeProfile} />
              </div>
              {plan ? (
                <>
                  <PlanCountGrid compact counts={plan.counts} />
                  <div className="mt-3 min-h-0 flex-1">
                    <CompactPlanList
                      dense
                      filter={filter}
                      items={filteredItems}
                      onFilterChange={handlers.onFilterChange}
                    />
                  </div>
                </>
              ) : (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Run Plan to preview changed items here while syncing.
                </p>
              )}
            </section>
            <section className="flex min-h-0 flex-col">
              {showRunPane ? (
                <RunProgressPanel
                  doctorResult={doctorResult}
                  logs={logs}
                  onBack={handlers.onBack}
                  onCancel={handlers.onCancel}
                  progress={runProgress}
                  running={running}
                  runLabel={runLabel}
                />
              ) : (
                <div className="flex h-full flex-col prism-section">
                  <h3 className="mb-2 text-sm font-semibold">Activity</h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Start a sync action to monitor progress here while reviewing the plan on the left.
                  </p>
                  <div className="mt-auto">
                    <LayoutActionButtons
                      disabled={running}
                      layout="vertical"
                      onDoctor={handlers.onDoctor}
                      onPlan={handlers.onPlan}
                      onPrune={handlers.onPrune}
                      onPush={handlers.onPush}
                    />
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </SidebarShell>
  );
}

export function UnifiedDashboardLayout(props: LayoutProps) {
  const {
    activeProfile,
    doctorResult,
    error,
    filter,
    filteredItems,
    handlers,
    logs,
    plan,
    profileForm,
    runLabel,
    runProgress,
    running,
    screen,
    sessionToken,
    settings,
    onCancelProfile,
    onPickFolder,
    onProfileFormChange,
    onSubmitProfile,
  } = props;

  return (
    <SidebarShell
      header={
        <div className="space-y-3">
          <AppHeader
            settings={settings}
            onAddProfile={handlers.onCreateProfile}
            onProfileChange={handlers.onProfileChange}
          />
          {activeProfile ? (
            <LayoutActionButtons
              disabled={running}
              size="compact"
              onDoctor={handlers.onDoctor}
              onPlan={handlers.onPlan}
              onPrune={handlers.onPrune}
              onPush={handlers.onPush}
            />
          ) : null}
        </div>
      }
    >
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {error ? <AlertBanner message={error} /> : null}

        {screen === "profile" ? (
          <ProfileSetupView
            form={profileForm}
            onCancel={onCancelProfile}
            onChange={onProfileFormChange}
            onPickFolder={onPickFolder}
            onSubmit={onSubmitProfile}
          />
        ) : null}

        {!activeProfile && screen !== "profile" ? (
          <WelcomeView onCreateProfile={handlers.onCreateProfile} />
        ) : null}

        {activeProfile && screen !== "profile" ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
            <section className="prism-section">
              <h2 className="mb-2 text-sm font-semibold">Profile health</h2>
              <ProfileHealthStrip profile={activeProfile} />
              <div className="mt-3">
                <TokenField
                  profile={activeProfile}
                  sessionToken={sessionToken}
                  onSessionTokenChange={handlers.onSessionTokenChange}
                />
              </div>
            </section>

            {(running || screen === "run") && (
              <RunProgressPanel
                doctorResult={doctorResult}
                logs={logs}
                onBack={handlers.onBack}
                onCancel={handlers.onCancel}
                progress={runProgress}
                running={running}
                runLabel={runLabel}
              />
            )}

            {plan ? (
              <section className="prism-section">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Plan summary</h3>
                  <span className="text-xs tabular-nums text-zinc-500">
                    {filteredItems.length} changed
                  </span>
                </div>
                <PlanCountGrid compact counts={plan.counts} />
                <div className="mt-3">
                  <CompactPlanList
                    filter={filter}
                    items={filteredItems}
                    onFilterChange={handlers.onFilterChange}
                  />
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </main>
    </SidebarShell>
  );
}

export function CompactToolbarLayout(props: LayoutProps) {
  const {
    activeProfile,
    doctorResult,
    error,
    filter,
    filteredItems,
    handlers,
    logs,
    plan,
    profileForm,
    runLabel,
    runProgress,
    running,
    screen,
    sessionToken,
    settings,
    onCancelProfile,
    onPickFolder,
    onProfileFormChange,
    onSubmitProfile,
  } = props;

  const tab = screen === "plan" ? "plan" : screen === "run" ? "activity" : "overview";

  return (
    <SidebarShell
      header={
        <div className="space-y-3">
          <AppHeader
            settings={settings}
            onAddProfile={handlers.onCreateProfile}
            onProfileChange={handlers.onProfileChange}
          />
          {activeProfile ? (
            <LayoutActionButtons
              disabled={running}
              size="compact"
              onDoctor={handlers.onDoctor}
              onPlan={handlers.onPlan}
              onPrune={handlers.onPrune}
              onPush={handlers.onPush}
            />
          ) : null}
          {activeProfile ? (
            <div className="flex items-center gap-1">
              {(["overview", "plan", "activity"] as const).map((entry) => (
                <button
                  key={entry}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize ${
                    tab === entry
                      ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-100"
                      : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`}
                  type="button"
                  onClick={() => {
                    if (entry === "overview") {
                      handlers.onBack();
                    } else if (entry === "plan" && plan) {
                      handlers.onViewPlan();
                    } else if (entry === "activity") {
                      handlers.onViewActivity();
                    }
                  }}
                >
                  {entry}
                </button>
              ))}
            </div>
          ) : null}
          {running && tab !== "activity" ? (
            <div className="rounded-lg border border-violet-300/50 bg-violet-50/60 px-3 py-2 dark:border-violet-500/30 dark:bg-violet-500/10">
              <RunProgressPanel
                compact
                showActions={false}
                doctorResult={null}
                logs={[]}
                progress={runProgress}
                running={running}
                runLabel={runLabel}
              />
            </div>
          ) : null}
        </div>
      }
    >
      <main className="min-h-0 flex-1 overflow-auto p-3 text-sm">
        {error ? <AlertBanner message={error} /> : null}

        {screen === "profile" ? (
          <ProfileSetupView
            form={profileForm}
            onCancel={onCancelProfile}
            onChange={onProfileFormChange}
            onPickFolder={onPickFolder}
            onSubmit={onSubmitProfile}
          />
        ) : null}

        {!activeProfile && screen !== "profile" ? (
          <WelcomeView onCreateProfile={handlers.onCreateProfile} />
        ) : null}

        {activeProfile && tab === "overview" && screen !== "profile" ? (
          <section className="prism-section">
            <ProfileHealthStrip compact profile={activeProfile} />
            <div className="mt-2">
              <TokenField
                profile={activeProfile}
                sessionToken={sessionToken}
                onSessionTokenChange={handlers.onSessionTokenChange}
              />
            </div>
          </section>
        ) : null}

        {activeProfile && tab === "plan" && plan ? (
          <section className="prism-section">
            <PlanCountGrid compact counts={plan.counts} />
            <div className="mt-2">
              <CompactPlanList
                dense
                filter={filter}
                items={filteredItems}
                onFilterChange={handlers.onFilterChange}
              />
            </div>
          </section>
        ) : null}

        {activeProfile && tab === "activity" ? (
          <RunProgressPanel
            compact
            doctorResult={doctorResult}
            logs={logs}
            onBack={handlers.onBack}
            onCancel={handlers.onCancel}
            progress={runProgress}
            running={running}
            runLabel={runLabel}
          />
        ) : null}
      </main>
    </SidebarShell>
  );
}

export function StatusBoardLayout(props: LayoutProps) {
  const {
    activeProfile,
    doctorResult,
    error,
    filter,
    filteredItems,
    handlers,
    logs,
    plan,
    profileForm,
    runLabel,
    runProgress,
    running,
    screen,
    sessionToken,
    settings,
    onCancelProfile,
    onPickFolder,
    onProfileFormChange,
    onSubmitProfile,
  } = props;

  return (
    <SidebarShell
      header={
        <AppHeader
          settings={settings}
          onAddProfile={handlers.onCreateProfile}
          onProfileChange={handlers.onProfileChange}
        />
      }
    >
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {error ? <AlertBanner message={error} /> : null}

        {screen === "profile" ? (
          <ProfileSetupView
            form={profileForm}
            onCancel={onCancelProfile}
            onChange={onProfileFormChange}
            onPickFolder={onPickFolder}
            onSubmit={onSubmitProfile}
          />
        ) : null}

        {!activeProfile && screen !== "profile" ? (
          <WelcomeView onCreateProfile={handlers.onCreateProfile} />
        ) : null}

        {activeProfile && screen !== "profile" ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-4">
              {plan ? (
                <>
                  <div className="prism-stat py-2">
                    <p className="prism-label">Upload</p>
                    <p className="text-xl font-semibold tabular-nums">{plan.counts.upload}</p>
                  </div>
                  <div className="prism-stat py-2">
                    <p className="prism-label">Update</p>
                    <p className="text-xl font-semibold tabular-nums">{plan.counts.update}</p>
                  </div>
                  <div className="prism-stat py-2">
                    <p className="prism-label">Delete</p>
                    <p className="text-xl font-semibold tabular-nums">{plan.counts.delete}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="prism-stat py-2 sm:col-span-3">
                    <p className="prism-label">Plan</p>
                    <p className="text-sm text-zinc-500">No plan yet</p>
                  </div>
                </>
              )}
              <div className="prism-stat py-2">
                <p className="prism-label">Last run</p>
                <p className="truncate text-sm">
                  {activeProfile.lastRun
                    ? `${activeProfile.lastRun.action} · ${activeProfile.lastRun.status}`
                    : "None"}
                </p>
              </div>
            </div>

            <section className="prism-section">
              <RunProgressPanel
                doctorResult={doctorResult}
                logs={logs}
                onBack={handlers.onBack}
                onCancel={handlers.onCancel}
                progress={runProgress}
                running={running}
                runLabel={runLabel}
              />
            </section>

            <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
              <section className="prism-section">
                <h3 className="mb-2 text-sm font-semibold">Quick actions</h3>
                <LayoutActionButtons
                  disabled={running}
                  layout="grid"
                  size="compact"
                  onDoctor={handlers.onDoctor}
                  onPlan={handlers.onPlan}
                  onPrune={handlers.onPrune}
                  onPush={handlers.onPush}
                />
                <div className="mt-3">
                  <TokenField
                    profile={activeProfile}
                    sessionToken={sessionToken}
                    onSessionTokenChange={handlers.onSessionTokenChange}
                  />
                </div>
              </section>
              <section className="prism-section">
                <h3 className="mb-2 text-sm font-semibold">Changed items</h3>
                {plan ? (
                  <CompactPlanList
                    dense
                    filter={filter}
                    items={filteredItems}
                    onFilterChange={handlers.onFilterChange}
                  />
                ) : (
                  <p className="text-xs text-zinc-500">Run Plan to populate the activity feed.</p>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </SidebarShell>
  );
}
