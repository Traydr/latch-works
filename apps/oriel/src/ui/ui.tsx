import { Check, ChevronDown, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useModeActive, useShell } from "../shell/shell";

/** Compacts the sidebar to the rail of icons, or expands it, in every mode at once (⌘\ too). */
function SidebarToggle() {
  const { rail, toggleRail } = useShell();
  const label = rail ? "Expand sidebar" : "Compact sidebar";

  return (
    <button
      type="button"
      className="lw-btn lw-btn-ghost lw-btn-icon -ml-1.5 shrink-0"
      aria-label={label}
      title={`${label}  ⌘\\`}
      data-sidebar-toggle
      onClick={toggleRail}
    >
      {rail ? <PanelLeftOpen /> : <PanelLeftClose />}
    </button>
  );
}

/**
 * A view's 52 px top bar, the same in every mode: the sidebar's compact toggle, the view's title
 * and a caption of counts on the left, at most two secondary controls and one primary on the
 * right. A screen with no title of its own (a welcome) still shows the bar, for the toggle. The
 * strip moves the window, as the sidebar's top does.
 */
export function TopBar({
  title,
  meta,
  children,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="lw-drag flex h-[52px] shrink-0 items-center gap-3 border-b lw-divider pr-5 pl-3">
      <SidebarToggle />
      {title === undefined ? null : (
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="lw-title truncate">{title}</h1>
          {meta ? (
            <span className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">{meta}</span>
          ) : null}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}

/** What a pane shows when it has nothing to list: an icon, one title line and one more line. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  actions,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      {Icon ? <Icon className="size-10 text-zinc-300 dark:text-zinc-600" /> : null}
      <p className="text-[15px] font-semibold">{title}</p>
      {children ? (
        <div className="max-w-sm text-[13px] text-zinc-500 dark:text-zinc-400">{children}</div>
      ) : null}
      {actions ? <div className="mt-2 flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ProgressBar({
  ratio,
  muted = false,
  className = "",
}: {
  ratio: number | null;
  /** Background analysis draws grey; work the owner started draws violet. */
  muted?: boolean;
  className?: string;
}) {
  const fill = muted ? "bg-zinc-400 dark:bg-zinc-500" : "bg-violet-500";

  return (
    <div
      className={`relative h-1 w-full overflow-hidden rounded-full bg-zinc-900/[0.07] dark:bg-white/[0.08] ${className}`}
    >
      {ratio === null ? (
        <div className={`absolute inset-y-0 w-1/3 animate-pulse rounded-full ${fill}`} />
      ) : (
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-linear ${fill}`}
          style={{ width: `${Math.round(Math.min(1, ratio) * 100)}%` }}
        />
      )}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-400/30 border-t-zinc-500 dark:border-t-zinc-300 ${className}`}
      aria-hidden
    />
  );
}

/**
 * A key or chord as a macOS keycap. Shortcuts live in tooltips and menus; a keycap shows only on
 * the one primary button that teaches its key.
 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="lw-kbd">{children}</kbd>;
}

/** A segmented control: one choice of a few, each with an optional count. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  fill = false,
}: {
  options: ReadonlyArray<{ value: T; label: string; count?: number; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Spans its container, the choices sharing the width equally, as at the top of a list. */
  fill?: boolean;
}) {
  return (
    <fieldset aria-label={label} className={fill ? "lw-seg flex w-full" : "lw-seg"}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={fill ? "lw-seg-item flex-1 justify-center" : "lw-seg-item"}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              {option.count.toLocaleString()}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  );
}

/** An on/off switch, for settings that apply as soon as they change. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-150 ${
        checked ? "bg-violet-600 dark:bg-violet-500" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.3)] transition-transform duration-150 ease-out ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

/**
 * A sheet over the window. Esc and a click outside close it; focus moves to the element marked
 * `data-autofocus` (or the first field, or the sheet) and returns on close.
 */
export function Sheet({
  title,
  description,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  const modeActive = useModeActive();

  latestClose.current = onClose;

  useEffect(() => {
    if (!modeActive) {
      return;
    }

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>("input") ??
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
  }, [modeActive]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes the sheet; Esc is the keyboard path.
    <div
      className="lw-enter-fade fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[8vh] backdrop-blur-[3px] dark:bg-black/50"
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
        className="lw-float lw-enter-pop flex max-h-[84vh] max-w-[92vw] flex-col overflow-hidden outline-none"
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
          <div className="min-w-0">
            <h2 className="lw-title">{title}</h2>
            {description ? <p className="lw-caption mt-1">{description}</p> : null}
          </div>
          <button
            type="button"
            className="lw-btn lw-btn-ghost lw-btn-icon-sm -mr-1.5"
            aria-label="Close"
            tabIndex={-1}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer ? (
          <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t lw-divider px-6">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** How much room a menu wants to the right of its button before it opens leftward. */
const PANEL_ROOM = 320;

/**
 * A button that opens a menu panel under it, for filters and options. The panel opens leftward
 * when the window has no room to its right. A click outside or Esc closes it.
 */
export function Menu({
  label,
  children,
  variant = "secondary",
  className = "",
  title,
  icon = false,
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  variant?: "secondary" | "ghost";
  className?: string;
  title?: string;
  /** An icon-only trigger, with no chevron. */
  icon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const modeActive = useModeActive();

  useEffect(() => {
    if (!open || !modeActive) {
      return;
    }

    const items = () => [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        ".lw-menu-item:not(:disabled), input:not(:disabled)",
      ) ?? []),
    ];

    // The first row takes focus, so the menu works from the keyboard as soon as it opens.
    const frame = window.requestAnimationFrame(() => items()[0]?.focus());

    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    // In the capture phase, so the view behind the menu never sees the keys the menu uses.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();

        return;
      }

      const list = items();
      const focused = document.activeElement;
      const at = focused instanceof HTMLElement ? list.indexOf(focused) : -1;

      const next =
        event.key === "ArrowDown"
          ? (at + 1) % list.length
          : event.key === "ArrowUp"
            ? (at - 1 + list.length) % list.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? list.length - 1
                : null;

      if (next !== null && list.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        list[next]?.focus();
      } else if (at >= 0 && (event.key === "Enter" || event.key === " ")) {
        // The focused row's own button handles these; nothing behind the menu should.
        event.stopPropagation();
      }
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, modeActive]);

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={icon ? title : undefined}
        title={title}
        onClick={(event) => {
          setAlignEnd(
            window.innerWidth - event.currentTarget.getBoundingClientRect().left < PANEL_ROOM,
          );
          setOpen((current) => !current);
        }}
        className={`lw-btn ${variant === "ghost" ? "lw-btn-ghost" : "lw-btn-secondary"} ${
          icon ? "lw-btn-icon" : "pr-3"
        }`}
      >
        {label}
        {icon ? null : <ChevronDown className="opacity-50" />}
      </button>
      {open ? (
        <div
          ref={panel}
          role="menu"
          id={id}
          className={`lw-menu absolute top-full mt-1.5 ${
            alignEnd ? "right-0 origin-top-right" : "left-0 origin-top-left"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A checkable row in a `Menu`, with an optional count; the check sits on the right, as in macOS
 * menus.
 */
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
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="lw-menu-item"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : <span className="text-xs text-zinc-400">{count}</span>}
      <Check
        className={`size-3.5 shrink-0 text-violet-600 dark:text-violet-400 ${
          checked ? "" : "invisible"
        }`}
      />
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="lw-menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="lw-menu-sep" />;
}

/**
 * Text cut from the start rather than the end, so a path keeps its last folder in view:
 * `…/Camera Roll/2021`.
 */
export function StartTruncate({ text, className = "" }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = box.current;

    if (!element) {
      return;
    }

    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <span
      ref={box}
      title={text}
      dir={overflowing ? "rtl" : undefined}
      className={`block truncate text-left ${className}`}
    >
      {/* The marks keep the path's own direction inside the right-to-left box. */}
      {overflowing ? `‎${text}‎` : text}
    </span>
  );
}

/** After each slash, so a path wraps between its folders rather than inside a name. */
const SLASH = "/​";

/**
 * A folder inside the root, written out in full so copies in different places can be told apart
 * without hovering: it wraps at its slashes over up to `lines` lines, the last folder stronger
 * than the ones above it. A path that still does not fit drops its first folders ("…/"), so the
 * folders nearest the file always show. The top of the root reads "Top folder".
 */
export function FolderPath({
  dir,
  lines,
  lead = "",
  className = "",
}: {
  dir: string;
  lines: number;
  /** Words before the path on its first line, such as "Also in". */
  lead?: string;
  className?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [dropped, setDropped] = useState(0);
  const segments = dir === "" ? [] : dir.split("/");

  useLayoutEffect(() => {
    const element = box.current;
    const probe = measure.current;
    const parts = dir === "" ? [] : dir.split("/");

    if (!element || !probe) {
      return;
    }

    // The probe takes each shortened path in turn, in the stronger weight so a fit is never
    // optimistic, until one fits the lines.
    const shorten = () => {
      const limit = (Number.parseFloat(getComputedStyle(probe).lineHeight) || 16) * lines + 1;
      let first = 0;

      for (; first < parts.length - 1; first += 1) {
        probe.textContent =
          (lead ? `${lead} ` : "") +
          (first > 0 ? `…${SLASH}` : "") +
          parts.slice(first).join(SLASH);

        if (probe.offsetHeight <= limit) {
          break;
        }
      }

      setDropped(first);
    };

    shorten();

    const observer = new ResizeObserver(shorten);

    observer.observe(element);

    return () => observer.disconnect();
  }, [dir, lines, lead]);

  const parents = [...(dropped > 0 ? ["…"] : []), ...segments.slice(dropped, -1)];
  const last = segments.at(-1);

  return (
    <span
      ref={box}
      title={dir || "The top of the folder"}
      className={`relative block ${className}`}
    >
      <span
        className="[overflow-wrap:anywhere]"
        style={{
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: lines,
          overflow: "hidden",
        }}
      >
        {lead ? `${lead} ` : null}
        {last === undefined ? (
          <span className="text-zinc-500 dark:text-zinc-400">Top folder</span>
        ) : (
          <>
            {parents.length > 0 ? (
              <span className="text-zinc-500 dark:text-zinc-400">
                {parents.join(SLASH)}
                {SLASH}
              </span>
            ) : null}
            <span className="font-medium">{last}</span>
          </>
        )}
      </span>
      <span
        ref={measure}
        aria-hidden
        className="pointer-events-none invisible absolute inset-x-0 top-0 font-medium [overflow-wrap:anywhere]"
      />
    </span>
  );
}
