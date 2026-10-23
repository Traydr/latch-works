import { X } from "lucide-react";
import type { ReactNode } from "react";

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <div className="ls-surface px-3.5 py-3" data-stat={label}>
      <div className="ls-label">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold tracking-tight">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-zinc-500">{detail}</div> : null}
    </div>
  );
}

export function ViewHeader({
  title,
  children,
  description,
}: {
  title: string;
  children?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b ls-divider px-5 py-3">
      <div className="min-w-0">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="ls-surface p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="ls-label">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="max-w-md text-xs text-zinc-500">{children}</div> : null}
    </div>
  );
}

export function ProgressBar({ ratio }: { ratio: number | null }) {
  return (
    <div className="relative h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      {ratio === null ? (
        <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-violet-500/60" />
      ) : (
        <div
          className="h-full rounded-full bg-violet-500"
          style={{ width: `${Math.round(Math.min(1, ratio) * 100)}%` }}
        />
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 pt-24 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ls-surface w-[440px] max-w-[92vw] p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            className="ls-btn ls-btn-ghost px-1.5"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="mt-3 text-xs">{children}</div>
        <div className="mt-4 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

export function Toggle<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-40 ${
            option.value === value
              ? "bg-violet-500/15 text-violet-700 dark:bg-violet-500/25 dark:text-violet-100"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
