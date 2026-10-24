import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastInput {
  message: string;
  detail?: string | null;
  tone?: "done" | "error" | "info";
  action?: ToastAction | null;
}

interface Toast {
  id: number;
  message: string;
  detail: string | null;
  tone: "done" | "error" | "info";
  action: ToastAction | null;
}

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Lifts toasts by this many pixels while a view has its own bar at the bottom of the pane. */
  setLift: (pixels: number) => void;
}

interface ToastState {
  toast: Toast | null;
  lift: number;
}

const ToastContext = createContext<ToastApi | null>(null);

const ToastStateContext = createContext<ToastState>({ toast: null, lift: 0 });

export function useToasts(): ToastApi {
  const toasts = useContext(ToastContext);

  if (!toasts) {
    throw new Error("useToasts needs a ToastProvider.");
  }

  return toasts;
}

/** Keeps toasts above a view's own floating bar while the view is on screen. */
export function useToastLift(pixels: number): void {
  const { setLift } = useToasts();

  useEffect(() => {
    setLift(pixels);

    return () => setLift(0);
  }, [pixels, setLift]);
}

/**
 * The result of what the owner just did, one at a time: a new result replaces the last, which
 * History keeps. Each carries its Undo.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [lift, setLift] = useState(0);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToast((current) => (current?.id === id ? null : current));
  }, []);

  const show = useCallback((input: ToastInput) => {
    const id = nextId.current;

    nextId.current += 1;

    setToast({
      id,
      message: input.message,
      detail: input.detail ?? null,
      tone: input.tone ?? "done",
      action: input.action ?? null,
    });

    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss, setLift }), [show, dismiss]);
  const state = useMemo(() => ({ toast, lift }), [toast, lift]);

  return (
    <ToastContext.Provider value={api}>
      <ToastStateContext.Provider value={state}>{children}</ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

/** Where toasts appear: bottom centre of the pane it is placed in. */
export function ToastViewport() {
  const { toast, lift } = useContext(ToastStateContext);
  const { dismiss } = useToasts();

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-40 w-max min-w-[320px] max-w-[min(520px,calc(100%-40px))] -translate-x-1/2 transition-[bottom] duration-200 ease-out"
      style={{ bottom: 24 + lift }}
      aria-live="polite"
    >
      {toast ? (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ) : null}
    </div>
  );
}

const ICONS = {
  done: <CircleCheck className="size-4 shrink-0 text-emerald-500" />,
  error: <CircleAlert className="size-4 shrink-0 text-red-500" />,
  info: <Info className="size-4 shrink-0 text-zinc-400" />,
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const latestDismiss = useRef(onDismiss);

  latestDismiss.current = onDismiss;

  useEffect(() => {
    if (hovered) {
      return;
    }

    const timer = window.setTimeout(
      () => latestDismiss.current(),
      toast.tone === "error" ? 15_000 : 8_000,
    );

    return () => window.clearTimeout(timer);
  }, [hovered, toast.tone]);

  return (
    <div
      role="status"
      data-toast={toast.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="lw-float lw-enter-rise group pointer-events-auto relative flex items-center gap-3 rounded-xl py-2.5 pr-2.5 pl-4"
    >
      {ICONS[toast.tone]}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{toast.message}</p>
        {toast.detail ? (
          <p className="lw-caption mt-0.5 truncate" title={toast.detail}>
            {toast.detail}
          </p>
        ) : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className="lw-btn lw-btn-secondary lw-btn-sm"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      {/* In the corner, as Sonner puts it, so it takes no width from the message. */}
      <button
        type="button"
        className="lw-float absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full text-zinc-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-zinc-900 focus-visible:opacity-100 dark:hover:text-zinc-100"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
