import { CircleAlert } from "lucide-react";

interface AlertBannerProps {
  message: string;
  variant?: "error" | "warning";
}

export function AlertBanner({ message, variant = "error" }: AlertBannerProps) {
  const tone =
    variant === "warning"
      ? "bg-amber-500/10 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"
      : "bg-red-500/[0.08] text-red-800 dark:bg-red-500/15 dark:text-red-200";

  return (
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-[13px] ${tone}`}
    >
      <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
      <p className="min-w-0">{message}</p>
    </div>
  );
}
