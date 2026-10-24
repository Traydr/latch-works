import { ChevronDown, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/** A view's title row: the title, a monospace line of counts, and the view's controls. */
export function ViewHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b ls-divider px-5 py-2">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {meta ? (
          <span className="ls-mono truncate text-[10.5px] text-zinc-500 tabular">{meta}</span>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <div className="flex max-w-md flex-col items-center gap-3 text-xs text-zinc-500">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ProgressBar({
  ratio,
  className = "",
}: {
  ratio: number | null;
  className?: string;
}) {
  return (
    <div
      className={`relative h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${className}`}
    >
      {ratio === null ? (
        <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-violet-500/60" />
      ) : (
        <div
          className="h-full rounded-full bg-violet-500 transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(Math.min(1, ratio) * 100)}%` }}
        />
      )}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-violet-400/30 border-t-violet-500 dark:border-t-violet-300 ${className}`}
      aria-hidden
    />
  );
}

/** A key or chord, drawn the way Lockstep shows its shortcuts. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ls-mono rounded border border-zinc-300 px-1 text-[9.5px] leading-[14px] font-normal text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      {children}
    </kbd>
  );
}

/** A segmented control: one choice of a few, each with an optional count. */
export function Toggle<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string; count?: number; disabled?: boolean }>;
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
          className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-40 ${
            option.value === value
              ? "bg-violet-500/15 text-violet-700 dark:bg-violet-500/25 dark:text-violet-100"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className="ls-mono text-[10px] opacity-70 tabular">
              {option.count.toLocaleString()}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A sheet over the window. Esc and a click outside close it; focus moves to the element marked
 * `data-autofocus` (or the first field or primary button, or the sheet) and returns on close.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);

  latestClose.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>("input, button.ls-btn-cta") ??
      panel.current;

    target?.focus();

    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latestClose.current();
      }
    };

    window.addEventListener("keydown", listener, true);

    return () => {
      window.removeEventListener("keydown", listener, true);
      previous?.focus();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes the sheet; Esc is the keyboard path.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 pt-20 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        className="ls-surface max-h-[80vh] max-w-[92vw] overflow-y-auto p-4 shadow-xl outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            className="ls-btn ls-btn-ghost px-1.5"
            aria-label="Close"
            tabIndex={-1}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="mt-3 text-xs">{children}</div>
        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/** How much room a dropdown panel wants to the right of its button before it opens leftward. */
const PANEL_ROOM = 320;

/**
 * A button that opens a panel under it, for filter menus and options. The panel opens leftward
 * when the window has no room to its right. A click outside or Esc closes it.
 */
export function Dropdown({
  label,
  active = false,
  children,
  className = "",
}: {
  label: ReactNode;
  active?: boolean;
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          setAlignEnd(
            window.innerWidth - event.currentTarget.getBoundingClientRect().left < PANEL_ROOM,
          );
          setOpen((current) => !current);
        }}
        className={`ls-btn h-[26px] py-0 ${active ? "ls-btn-primary" : ""}`}
      >
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open ? (
        <div
          id={id}
          className={`ls-surface absolute top-full z-40 mt-1 min-w-52 p-1 shadow-lg ${
            alignEnd ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** A checkable row in a `Dropdown`, with an optional count on the right. */
export function MenuCheck({
  checked,
  label,
  count,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: ReactNode;
  count?: ReactNode;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-default items-center gap-2 rounded px-2 py-1 text-xs ${
        disabled ? "opacity-40" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-violet-600"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="ls-mono text-[10px] text-zinc-500 tabular">{count}</span>
      )}
    </label>
  );
}
