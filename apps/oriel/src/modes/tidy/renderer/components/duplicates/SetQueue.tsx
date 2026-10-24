import { type DuplicateSet, type FileId, isCloseCall } from "@latch-works/glazier-core/contract";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatBytes, plural } from "../../lib/format";
import { Thumbnail } from "../media";
import { filesOf, keptIds } from "./model";

const ROW_HEIGHT = 60;

/**
 * The sets left to decide, one row each with the keeper's thumbnail, loaded as the list scrolls.
 * A close call carries an amber dot; a skipped set is dimmed.
 */
export function SetQueue({
  sets,
  total,
  activeIndex,
  skipped,
  overrides,
  header,
  onSelect,
  onNearEnd,
}: {
  sets: readonly DuplicateSet[];
  total: number;
  activeIndex: number;
  skipped: ReadonlySet<string>;
  overrides: ReadonlyMap<string, FileId[]>;
  header: ReactNode;
  onSelect: (index: number) => void;
  onNearEnd: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const element = container.current;

    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => setHeight(element.clientHeight));

    observer.observe(element);
    setHeight(element.clientHeight);

    return () => observer.disconnect();
  }, []);

  // Keyboard moves keep the active set in view.
  useEffect(() => {
    const element = container.current;

    if (!element) {
      return;
    }

    const top = activeIndex * ROW_HEIGHT;

    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  }, [activeIndex]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
  const last = Math.min(sets.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 6);

  useEffect(() => {
    if (Math.max(last, activeIndex) >= sets.length - 10 && sets.length < total) {
      onNearEnd();
    }
  }, [last, activeIndex, sets.length, total, onNearEnd]);

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r gz-divider xl:w-[264px]">
      <div className="shrink-0 px-3 pt-3 pb-2">{header}</div>
      <div
        ref={container}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: sets.length * ROW_HEIGHT }} className="relative">
          {sets.slice(first, last).map((set, offset) => {
            const position = first + offset;
            const files = filesOf(set);
            const kept = keptIds(set, overrides.get(set.key));
            const keeper = files.find((file) => kept.includes(file.id)) ?? files[0];
            const isSkipped = skipped.has(set.key);
            const closeCall = !overrides.has(set.key) && isCloseCall(set);

            return (
              <button
                key={set.key}
                type="button"
                aria-current={position === activeIndex}
                data-set-key={set.key}
                onClick={() => onSelect(position)}
                style={{ top: position * ROW_HEIGHT + 2, height: ROW_HEIGHT - 4 }}
                className={`absolute inset-x-0 flex items-center gap-3 rounded-lg px-2 text-left ${
                  position === activeIndex ? "gz-selected" : "gz-hover"
                } ${isSkipped ? "opacity-55" : ""}`}
              >
                {keeper ? <Thumbnail row={keeper} size={40} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{keeper?.name}</span>
                  <span className="gz-caption flex items-center gap-1.5">
                    {closeCall ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        title="Close call: the versions look the same"
                      />
                    ) : null}
                    <span className="truncate">
                      {isSkipped
                        ? "Skipped"
                        : `${
                            set.kind === "exact"
                              ? plural(files.length, "copy", "copies")
                              : plural(set.versions.length, "version")
                          } · ${formatBytes(set.reclaimableBytes)}`}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
