import type { SelectionSummary } from "@latch-works/glazier-core/contract";
import { Ellipsis, X } from "lucide-react";

import { formatBytes, formatCount } from "../../lib/format";
import { useToastLift } from "../Toasts";
import { convertLabel } from "./labels";

/** Frame View's floating capsule: what is selected, and what can be done to all of it. */
export function SelectionBar({
  count,
  summary,
  onConvert,
  onHold,
  onMoveTo,
  onMore,
  onClear,
}: {
  count: number;
  summary: SelectionSummary | null;
  onConvert: () => void;
  onHold: () => void;
  onMoveTo: () => void;
  onMore: () => void;
  onClear: () => void;
}) {
  useToastLift(64);

  return (
    <div
      role="toolbar"
      aria-label="Selection"
      className="lw-float lw-enter-rise absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 p-1.5"
    >
      <span className="lw-caption px-2 whitespace-nowrap">
        {formatCount(count)} selected
        {summary ? ` · ${formatBytes(summary.bytes)}` : ""}
      </span>
      <span className="h-5 w-px bg-zinc-200 dark:bg-white/10" />
      {summary && summary.convertible.files > 0 ? (
        <button type="button" className="lw-btn lw-btn-primary" onClick={onConvert}>
          {convertLabel(summary.convertible.files, summary.files)}
        </button>
      ) : null}
      <button type="button" className="lw-btn lw-btn-secondary" title="⌘⌫" onClick={onHold}>
        Move to holding
      </button>
      <button type="button" className="lw-btn lw-btn-secondary" title="⇧⌘M" onClick={onMoveTo}>
        Move to…
      </button>
      <button
        type="button"
        className="lw-btn lw-btn-ghost lw-btn-icon"
        aria-label="More actions"
        title="More actions"
        onClick={onMore}
      >
        <Ellipsis />
      </button>
      <button
        type="button"
        className="lw-btn lw-btn-ghost lw-btn-icon"
        aria-label="Clear selection"
        title="Esc"
        onClick={onClear}
      >
        <X />
      </button>
    </div>
  );
}
