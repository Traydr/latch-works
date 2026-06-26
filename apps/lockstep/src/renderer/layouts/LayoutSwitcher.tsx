import { useLayoutVariant } from "./LayoutContext";
import { layoutLabels, type LayoutVariant } from "./types";

const variants: LayoutVariant[] = [1, 2, 3, 4, 5];

export function LayoutSwitcher() {
  const { variant, setVariant } = useLayoutVariant();

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50">
      <div className="pointer-events-auto prism-surface flex items-center gap-2 px-3 py-2 shadow-2xl">
        <span className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Layout preview
        </span>
        <div className="flex items-center gap-1">
          {variants.map((entry) => (
            <button
              key={entry}
              className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs font-semibold tabular-nums transition ${
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
  );
}
