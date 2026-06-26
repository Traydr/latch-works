import { useLayoutVariant } from "./LayoutContext";
import { layoutLabels, type LayoutVariant } from "./types";

const variants: LayoutVariant[] = [1, 2, 3, 4, 5];

export function LayoutSwitcher() {
  const { variant, setVariant } = useLayoutVariant();

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center">
        <div className="rounded-lg border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-xs font-semibold text-violet-100 backdrop-blur-sm">
          Layout {variant}: {layoutLabels[variant]}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 z-50">
        <div className="pointer-events-auto prism-surface flex items-center gap-2 px-3 py-2 shadow-2xl">
          <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Layout preview
          </span>
          <div className="flex items-center gap-1">
            {variants.map((entry) => (
              <button
                key={entry}
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold tabular-nums transition ${
                  variant === entry
                    ? "bg-violet-500 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
                title={layoutLabels[entry]}
                type="button"
                onClick={() => setVariant(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
