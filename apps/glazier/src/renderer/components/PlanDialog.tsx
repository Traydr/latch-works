import type { PlanPreview, PlanRequest, PlanStepAction } from "@latch-works/glazier-core/contract";
import { AlertTriangle, ArrowRightLeft, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { call } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { formatBytes, formatCount } from "../lib/format";

const ACTION_LABELS = {
  hold: "Move to holding",
  move: "Move",
  rename: "Rename",
  "convert-avif": "Convert to AVIF",
  "convert-animation": "Animation to MP4",
  "convert-video": "Rewrite as MP4",
  "remove-folder": "Remove empty folder",
} as const satisfies Record<PlanStepAction, string>;

interface Proposal {
  title: string;
  request: PlanRequest;
}

interface PlannerApi {
  /** Previews a plan and asks the owner to apply it. Resolves once it is applied or dismissed. */
  propose: (title: string, request: PlanRequest) => void;
}

const PlannerContext = createContext<PlannerApi | null>(null);

export function usePlanner(): PlannerApi {
  const planner = useContext(PlannerContext);

  if (!planner) {
    throw new Error("usePlanner needs a PlanProvider.");
  }

  return planner;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "loading"; proposal: Proposal }
  | { kind: "review"; proposal: Proposal; preview: PlanPreview }
  | { kind: "failed"; proposal: Proposal; message: string };

export function PlanProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [applying, setApplying] = useState(false);
  const { report } = useEngine();

  const propose = useCallback((title: string, request: PlanRequest) => {
    const proposal = { title, request };
    setState({ kind: "loading", proposal });

    call("previewPlan", request).then(
      (preview) => setState({ kind: "review", proposal, preview }),
      (error: Error) => setState({ kind: "failed", proposal, message: error.message }),
    );
  }, []);

  const close = useCallback(() => {
    if (state.kind === "review") {
      void call("discardPlan", { planId: state.preview.planId }).catch(() => undefined);
    }

    setState({ kind: "closed" });
  }, [state]);

  const apply = useCallback(async () => {
    if (state.kind !== "review") {
      return;
    }

    setApplying(true);

    try {
      await call("applyPlan", { planId: state.preview.planId });
      setState({ kind: "closed" });
    } catch (error) {
      report(error);
    } finally {
      setApplying(false);
    }
  }, [state, report]);

  const api = useMemo(() => ({ propose }), [propose]);

  return (
    <PlannerContext.Provider value={api}>
      {children}
      {state.kind === "closed" ? null : (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 pt-24 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={state.proposal.title}
            className="ls-surface w-[480px] max-w-[92vw] p-4 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="ls-label">Plan</div>
                <h2 className="mt-0.5 text-sm font-semibold">{state.proposal.title}</h2>
              </div>
              <button
                type="button"
                className="ls-btn ls-btn-ghost px-1.5"
                aria-label="Close"
                onClick={close}
              >
                <X className="size-3.5" />
              </button>
            </div>

            {state.kind === "loading" ? (
              <p className="mt-4 text-xs text-zinc-500">Working out what would change…</p>
            ) : null}

            {state.kind === "failed" ? (
              <p className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-200">
                {state.message}
              </p>
            ) : null}

            {state.kind === "review" ? <PreviewBody preview={state.preview} /> : null}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="ls-btn" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="ls-btn ls-btn-cta"
                disabled={state.kind !== "review" || applying}
                onClick={() => void apply()}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </PlannerContext.Provider>
  );
}

function PreviewBody({ preview }: { preview: PlanPreview }) {
  return (
    <div className="mt-3 space-y-3 text-xs">
      <ul className="ls-surface-2 divide-y divide-zinc-200 dark:divide-zinc-800">
        {preview.byAction.map((entry) => (
          <li key={entry.action} className="flex justify-between px-3 py-1.5">
            <span>{ACTION_LABELS[entry.action]}</span>
            <span className="tabular text-zinc-500">{formatCount(entry.steps)}</span>
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-zinc-600 dark:text-zinc-300">
        <dt className="text-zinc-500">Files touched</dt>
        <dd className="tabular text-right">{formatBytes(preview.bytesTouched)}</dd>
        <dt className="text-zinc-500">Moved to holding</dt>
        <dd className="tabular text-right">{formatBytes(preview.bytesToHolding)}</dd>
      </dl>

      <p className="text-zinc-500">
        Nothing is deleted: removed files and replaced originals go to the root's holding folder,
        which Lockstep and Frame View skip. Every step can be undone from the journal.
      </p>

      {preview.lockstep.removedPaths + preview.lockstep.addedPaths > 0 ? (
        <p className="flex gap-2 rounded-md bg-sky-500/10 px-3 py-2 text-sky-800 dark:text-sky-200">
          <ArrowRightLeft className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Lockstep will see {formatCount(preview.lockstep.removedPaths)} removed and{" "}
            {formatCount(preview.lockstep.addedPaths)} new paths. Afterwards run{" "}
            <code>lockstep plan</code>, <code>push</code>, then <code>prune</code>.
          </span>
        </p>
      ) : null}

      {preview.warnings.map((warning) => (
        <p
          key={warning}
          className="flex gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}
