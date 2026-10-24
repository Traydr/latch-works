import { CircleAlert, CircleCheck, X } from "lucide-react";
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
}

const ToastContext = createContext<ToastApi | null>(null);

const VISIBLE_TOASTS = 3;

export function useToasts(): ToastApi {
  const toasts = useContext(ToastContext);

  if (!toasts) {
    throw new Error("useToasts needs a ToastProvider.");
  }

  return toasts;
}

/** Results of what the owner just did, bottom right above the status bar, each with its Undo. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((input: ToastInput) => {
    const id = nextId.current;

    nextId.current += 1;

    const toast: Toast = {
      id,
      message: input.message,
      detail: input.detail ?? null,
      tone: input.tone ?? "done",
      action: input.action ?? null,
    };

    setToasts((current) => [...current.slice(-(VISIBLE_TOASTS - 1)), toast]);

    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-[84px] z-40 flex w-[360px] flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

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
      className="ls-surface pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 text-xs shadow-lg"
    >
      {toast.tone === "error" ? (
        <CircleAlert className="mt-px size-3.5 shrink-0 text-red-500" />
      ) : (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-emerald-500" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{toast.message}</p>
        {toast.detail ? (
          <p className="ls-mono mt-0.5 text-[10.5px] break-words text-zinc-500">{toast.detail}</p>
        ) : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className="ls-btn py-0.5"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="ls-btn ls-btn-ghost -mr-1 px-1 py-0.5"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
