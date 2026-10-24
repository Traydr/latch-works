import { AlertTriangle } from "lucide-react";

interface AlertBannerProps {
  message: string;
  variant?: "error" | "warning";
}

export function AlertBanner({ message, variant = "error" }: AlertBannerProps) {
  const styles =
    variant === "warning"
      ? "border-amber-300/80 bg-amber-50/90 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
      : "border-red-300/80 bg-red-50/90 text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100";

  return (
    <div className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${styles}`}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{message}</p>
    </div>
  );
}
