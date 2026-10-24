import type { ModeId } from "../shared/shell";
import { MODE_META } from "./mode-meta";
import { type ModeActivity, useShell } from "./shell";

/** A ring for work with a known end, a dot for work without one. */
function ActivityMark({ activity, className }: { activity: ModeActivity; className: string }) {
  if (activity.kind === "working") {
    return (
      <span
        className={`size-1.5 rounded-full bg-violet-500 motion-safe:animate-pulse ${className}`}
        aria-hidden
      />
    );
  }

  const circumference = 2 * Math.PI * 4;

  return (
    <svg viewBox="0 0 10 10" className={`size-2.5 -rotate-90 ${className}`} aria-hidden>
      <circle
        cx="5"
        cy="5"
        r="4"
        fill="none"
        strokeWidth="2"
        className="stroke-zinc-900/15 dark:stroke-white/15"
      />
      <circle
        cx="5"
        cy="5"
        r="4"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-violet-500"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - activity.ratio)}
      />
    </svg>
  );
}

function describe(label: string, activity: ModeActivity | undefined): string {
  if (!activity) {
    return label;
  }

  return activity.kind === "progress"
    ? `${label} · ${Math.round(activity.ratio * 100)}% done`
    : `${label} · working`;
}

/**
 * View · Tidy · Sync, at the top of every mode's sidebar: a segmented control when the sidebar is
 * full, and the three mode icons stacked above the mode's own when it is the rail. A mode working
 * while another shows says so on its button: a ring while a push or a change runs, a dot while a
 * scan or analysis does.
 */
export function ModeSwitcher({ rail }: { rail: boolean }) {
  const { mode, go, insetTitleBar, activity } = useShell();

  /** The work to show for `id`: none on the mode the owner is looking at. */
  const workOf = (id: ModeId) => (id === mode ? undefined : activity[id]);

  if (rail) {
    // The rail's buttons: 48 px targets in the 88 px macOS rail, 40 px elsewhere, as in Glazier.
    const button = insetTitleBar
      ? "size-12 rounded-xl [&_svg]:size-[22px]"
      : "size-10 rounded-lg [&_svg]:size-5";

    return (
      <nav aria-label="Mode" className="flex w-full flex-col items-center">
        <ul className="flex flex-col items-center space-y-1">
          {MODE_META.map(({ id, label, icon: Icon, shortcut }) => {
            const work = workOf(id);

            return (
              <li key={id}>
                <button
                  type="button"
                  className={`lw-sidebar-item relative justify-center px-0 ${button}`}
                  aria-current={mode === id ? "page" : undefined}
                  aria-label={label}
                  data-mode={id}
                  data-mode-activity={work?.kind}
                  title={`${describe(label, work)}  ${shortcut}`}
                  onClick={() => go(id)}
                >
                  <Icon />
                  {work ? (
                    <ActivityMark activity={work} className="absolute top-1.5 right-1.5" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="my-3 h-px w-8 bg-zinc-200 dark:bg-white/[0.08]" aria-hidden />
      </nav>
    );
  }

  return (
    <nav aria-label="Mode" className="w-full px-2 pb-1">
      <div className="lw-seg w-full">
        {MODE_META.map(({ id, label, icon: Icon, shortcut }) => {
          const work = workOf(id);

          return (
            <button
              key={id}
              type="button"
              className="lw-seg-item flex-1 justify-center [&_svg]:size-3.5"
              aria-pressed={mode === id}
              data-mode={id}
              data-mode-activity={work?.kind}
              title={`${describe(label, work)}  ${shortcut}`}
              onClick={() => go(id)}
            >
              <Icon />
              {label}
              {work ? <ActivityMark activity={work} className="-ml-0.5" /> : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
