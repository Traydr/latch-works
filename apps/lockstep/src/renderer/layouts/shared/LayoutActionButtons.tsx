import { ArrowUpCircle, Play, Stethoscope, Trash2 } from "lucide-react";

interface LayoutActionButtonsProps {
  disabled?: boolean;
  layout?: "horizontal" | "vertical" | "grid";
  onDoctor: () => void;
  onPlan: () => void;
  onPrune: () => void;
  onPush: () => void;
  size?: "default" | "compact";
}

const labels = {
  default: {
    doctor: "Test connection",
    plan: "Plan",
    push: "Push uploads/updates",
    prune: "Apply deletes",
  },
  compact: {
    doctor: "Test",
    plan: "Plan",
    push: "Push",
    prune: "Deletes",
  },
} as const;

export function LayoutActionButtons({
  disabled = false,
  layout = "horizontal",
  onDoctor,
  onPlan,
  onPrune,
  onPush,
  size = "default",
}: LayoutActionButtonsProps) {
  const text = labels[size];

  const containerClass =
    layout === "vertical"
      ? "flex flex-col gap-2"
      : layout === "grid"
        ? "grid grid-cols-2 gap-2"
        : "flex flex-wrap items-center gap-2";

  const buttonClass =
    size === "compact"
      ? "prism-btn min-w-[5.5rem] px-2.5 py-2"
      : "prism-btn min-w-[6.5rem] px-3 py-2";

  return (
    <div className={containerClass}>
      <button
        className={buttonClass}
        disabled={disabled}
        title={labels.default.doctor}
        type="button"
        onClick={onDoctor}
      >
        <Stethoscope className="size-3.5 shrink-0" aria-hidden />
        {text.doctor}
      </button>
      <button
        className={`${buttonClass} prism-btn-primary`}
        disabled={disabled}
        title={labels.default.plan}
        type="button"
        onClick={onPlan}
      >
        <Play className="size-3.5 shrink-0" aria-hidden />
        {text.plan}
      </button>
      <button
        className={`${buttonClass} prism-btn-primary`}
        disabled={disabled}
        title={labels.default.push}
        type="button"
        onClick={onPush}
      >
        <ArrowUpCircle className="size-3.5 shrink-0" aria-hidden />
        {text.push}
      </button>
      <button
        className={`${buttonClass} prism-btn-danger`}
        disabled={disabled}
        title={labels.default.prune}
        type="button"
        onClick={onPrune}
      >
        <Trash2 className="size-3.5 shrink-0" aria-hidden />
        {text.prune}
      </button>
    </div>
  );
}
