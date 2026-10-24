import { MODE_META } from "./mode-meta";
import { useShell } from "./shell";

/**
 * View · Tidy · Sync, at the top of every mode's sidebar: a segmented control when the sidebar is
 * full, and the three mode icons stacked above the mode's own when it is the rail.
 */
export function ModeSwitcher({ rail }: { rail: boolean }) {
  const { mode, go, insetTitleBar } = useShell();

  if (rail) {
    // The rail's buttons: 48 px targets in the 88 px macOS rail, 40 px elsewhere, as in Glazier.
    const button = insetTitleBar
      ? "size-12 rounded-xl [&_svg]:size-[22px]"
      : "size-10 rounded-lg [&_svg]:size-5";

    return (
      <nav aria-label="Mode" className="flex w-full flex-col items-center">
        <ul className="flex flex-col items-center space-y-1">
          {MODE_META.map(({ id, label, icon: Icon, shortcut }) => (
            <li key={id}>
              <button
                type="button"
                className={`gz-sidebar-item justify-center px-0 ${button}`}
                aria-current={mode === id ? "page" : undefined}
                aria-label={label}
                data-mode={id}
                title={`${label}  ${shortcut}`}
                onClick={() => go(id)}
              >
                <Icon />
              </button>
            </li>
          ))}
        </ul>
        <div className="my-3 h-px w-8 bg-zinc-200 dark:bg-white/[0.08]" aria-hidden />
      </nav>
    );
  }

  return (
    <nav aria-label="Mode" className="w-full px-2 pb-1">
      <div className="gz-seg w-full">
        {MODE_META.map(({ id, label, icon: Icon, shortcut }) => (
          <button
            key={id}
            type="button"
            className="gz-seg-item flex-1 justify-center [&_svg]:size-3.5"
            aria-pressed={mode === id}
            data-mode={id}
            title={shortcut}
            onClick={() => go(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
