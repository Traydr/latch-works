import type { LockstepPlan, LockstepProfilePublic } from "../../shared/types";
import { PlanCountGrid } from "../components/PlanCountGrid";
import { ProfileSummary } from "../components/ProfileSummary";

interface DashboardViewProps {
  plan: LockstepPlan | null;
  profile: LockstepProfilePublic;
  sessionToken: string;
  onSessionTokenChange: (value: string) => void;
  onViewPlan: () => void;
}

export function DashboardView({
  plan,
  profile,
  sessionToken,
  onSessionTokenChange,
  onViewPlan,
}: DashboardViewProps) {
  return (
    <>
      <section className="prism-section">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Dashboard</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Review profile health, plan changes, and run sync actions from the dock below.
            </p>
          </div>
          <span className="prism-pill">{profile.name}</span>
        </div>

        <ProfileSummary profile={profile} />

        {!profile.tokenConfigured ? (
          <label className="mt-4 grid gap-1.5">
            <span className="prism-label">Sync API token</span>
            <input
              className="prism-input"
              type="password"
              value={sessionToken}
              onChange={(event) => onSessionTokenChange(event.target.value)}
              placeholder="Enter token for this session"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {profile.tokenUnreadable
                ? "Lockstep could not unlock the stored token. Enter it again to save securely or keep it in memory until you quit."
                : "OS encryption is unavailable here, so the token stays in memory until you quit Lockstep."}
            </p>
          </label>
        ) : null}
      </section>

      {plan ? (
        <section className="prism-section">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold tracking-tight">Latest plan</h3>
              <p className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
                Skipped files: {plan.skipped.toLocaleString()}
              </p>
            </div>
            <button className="prism-btn" type="button" onClick={onViewPlan}>
              View plan details
            </button>
          </div>
          <PlanCountGrid counts={plan.counts} />
        </section>
      ) : null}
    </>
  );
}
