import { ArrowUpCircle, Play, Stethoscope, Trash2 } from "lucide-react";

interface LayoutActionButtonsProps {
  disabled?: boolean;
  layout?: "horizontal" | "vertical" | "grid";
  onDoctor: () => void;
  onPlan: () => void;
  onPrune: () => void;
  onPush: () => void;
}

export function LayoutActionButtons({
  disabled = false,
  layout = "horizontal",
  onDoctor,
  onPlan,
  onPrune,
  onPush,
}: LayoutActionButtonsProps) {
  const containerClass =
    layout === "vertical"
      ? "flex flex-col gap-2"
      : layout === "grid"
        ? "grid grid-cols-2 gap-2"
        : "flex flex-wrap items-center gap-2";

  return (
    <div className={containerClass}>
      <button
        className="prism-btn inline-flex items-center justify-center gap-1.5"
        disabled={disabled}
        type="button"
        onClick={onDoctor}
      >
        <Stethoscope className="size-3.5" aria-hidden />
        Test connection
      </button>
      <button
        className="prism-btn prism-btn-primary inline-flex items-center justify-center gap-1.5"
        disabled={disabled}
        type="button"
        onClick={onPlan}
      >
        <Play className="size-3.5" aria-hidden />
        Plan
      </button>
      <button
        className="prism-btn prism-btn-primary inline-flex items-center justify-center gap-1.5"
        disabled={disabled}
        type="button"
        onClick={onPush}
      >
        <ArrowUpCircle className="size-3.5" aria-hidden />
        Push uploads/updates
      </button>
      <button
        className="prism-btn prism-btn-danger inline-flex items-center justify-center gap-1.5"
        disabled={disabled}
        type="button"
        onClick={onPrune}
      >
        <Trash2 className="size-3.5" aria-hidden />
        Apply deletes
      </button>
    </div>
  );
}
