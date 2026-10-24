import type {
  Job,
  JobId,
  PlanId,
  PlanPreview,
  PlanRequest,
  PlanSummary,
} from "@latch-works/glazier-core/contract";
import { AlertTriangle } from "lucide-react";
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

import { useToasts } from "../components/Toasts";
import { Modal } from "../components/ui";
import { call } from "./api";
import { useEngine } from "./engine-state";
import { formatBytes, formatCount, plural } from "./format";

/** Something the owner did that ⌘Z can take back. */
interface UndoEntry {
  /** The plan it reverses, so undoing that plan any other way drops the entry. */
  planId: PlanId | null;
  run: () => Promise<void>;
}

interface PerformOptions {
  /** Ties the result to a place in the UI, such as a Tidy step, so it can show it. */
  source?: string;
  /** The confirm button's label when the plan has warnings, such as "Remove anyway". */
  confirmLabel?: string;
}

interface ActionsApi {
  /**
   * Runs a plan now and reports it with a toast that offers Undo. A plan with warnings asks
   * first. Resolves with the finished plan, or null when nothing ran.
   */
  perform: (request: PlanRequest, options?: PerformOptions) => Promise<PlanSummary | null>;
  undoPlan: (plan: PlanSummary) => Promise<void>;
  /** Adds a non-plan change (a dismissal, a preference) to ⌘Z's history. */
  pushUndo: (run: () => Promise<void>) => void;
  undoLast: () => Promise<void>;
  /** The newest finished plan started from `source` this session. */
  resultFor: (source: string) => PlanSummary | null;
  /** The running job of a plan started from `source`, if any. */
  jobFor: (source: string) => Job | null;
  /** Waits for a job the engine started, such as an analysis, to finish. */
  waitForJob: (job: Job) => Promise<Job>;
}

const ActionsContext = createContext<ActionsApi | null>(null);

export function useActions(): ActionsApi {
  const actions = useContext(ActionsContext);

  if (!actions) {
    throw new Error("useActions needs an ActionsProvider.");
  }

  return actions;
}

const CONVERSION_KINDS = new Set<PlanSummary["kind"]>(["optimize", "reencode", "strip-audio"]);

function isTerminal(job: Job): boolean {
  return job.state === "done" || job.state === "failed" || job.state === "cancelled";
}

export function canUndo(plan: PlanSummary): boolean {
  return (
    plan.done > 0 &&
    (plan.status === "applied" || plan.status === "partial" || plan.status === "cancelled")
  );
}

/** The numbers under a plan's title: what it saved or held, and what it left out. */
export function describePlan(plan: PlanSummary): string {
  const parts: string[] = [];

  if (CONVERSION_KINDS.has(plan.kind) && plan.bytesBefore > 0) {
    parts.push(`${formatBytes(plan.bytesBefore)} → ${formatBytes(plan.bytesAfter)}`);
  } else if (plan.held.files > 0) {
    parts.push(`${plural(plan.held.files, "file")} to holding · ${formatBytes(plan.held.bytes)}`);
  }

  if (plan.skipped > 0) {
    parts.push(
      CONVERSION_KINDS.has(plan.kind) ? `${plan.skipped} kept as is` : `${plan.skipped} skipped`,
    );
  }

  if (plan.failed > 0) {
    parts.push(`${plan.failed} failed`);
  }

  if (plan.undone > 0) {
    parts.push(plan.status === "undone" ? "undone" : `${plan.undone} undone`);
  }

  return parts.join(" · ");
}

interface PendingWarning {
  preview: PlanPreview;
  confirmLabel: string;
  decide: (apply: boolean) => void;
}

export function ActionsProvider({ children }: { children: ReactNode }) {
  const { jobs, rootId } = useEngine();
  const toasts = useToasts();
  const [warning, setWarning] = useState<PendingWarning | null>(null);
  const [results, setResults] = useState<Map<string, PlanSummary>>(new Map());
  const [sourceJobs, setSourceJobs] = useState<Map<string, JobId>>(new Map());
  const waiters = useRef(new Map<JobId, Array<(job: Job) => void>>());
  const undoStack = useRef<UndoEntry[]>([]);
  const jobsRef = useRef(jobs);

  jobsRef.current = jobs;

  // Settles whoever waits on a job once the engine reports it finished.
  useEffect(() => {
    for (const job of jobs) {
      const pending = waiters.current.get(job.id);

      if (pending && isTerminal(job)) {
        waiters.current.delete(job.id);

        for (const resolve of pending) {
          resolve(job);
        }
      }
    }
  }, [jobs]);

  const waitForJob = useCallback(
    (job: Job) =>
      new Promise<Job>((resolve) => {
        const known = jobsRef.current.find((candidate) => candidate.id === job.id) ?? job;

        if (isTerminal(known)) {
          resolve(known);

          return;
        }

        waiters.current.set(job.id, [...(waiters.current.get(job.id) ?? []), resolve]);
      }),
    [],
  );

  const runUndo = useCallback(
    async (plan: PlanSummary) => {
      try {
        const job = await call("undoPlan", { planId: plan.id });
        const finished = await waitForJob(job);

        undoStack.current = undoStack.current.filter((entry) => entry.planId !== plan.id);

        setResults((current) => {
          const next = new Map(current);

          for (const [source, result] of current) {
            if (result.id === plan.id) {
              next.delete(source);
            }
          }

          return next;
        });

        toasts.show(
          finished.state === "done"
            ? { message: `Undid “${plan.title}”`, tone: "info" }
            : { message: "Undo did not finish", detail: finished.message, tone: "error" },
        );
      } catch (error) {
        toasts.show({ message: "Undo failed", detail: String(error), tone: "error" });
      }
    },
    [toasts, waitForJob],
  );

  const announce = useCallback(
    (plan: PlanSummary, job: Job) => {
      const undo = canUndo(plan);

      if (undo) {
        undoStack.current = [
          ...undoStack.current.slice(-49),
          { planId: plan.id, run: () => runUndo(plan) },
        ];
      }

      if (job.state === "failed") {
        toasts.show({
          message: `${plan.title}, with errors`,
          detail: job.message ?? describePlan(plan),
          tone: "error",
          action: undo ? { label: "Undo", run: () => void runUndo(plan) } : null,
        });

        return;
      }

      toasts.show({
        message:
          job.state === "cancelled"
            ? `Stopped after ${formatCount(plan.done)} of ${formatCount(plan.steps)}`
            : plan.title,
        detail: describePlan(plan) || null,
        tone: plan.failed > 0 ? "error" : "done",
        action: undo ? { label: "Undo", run: () => void runUndo(plan) } : null,
      });
    },
    [toasts, runUndo],
  );

  const perform = useCallback(
    async (request: PlanRequest, options: PerformOptions = {}): Promise<PlanSummary | null> => {
      try {
        const performed = await call("perform", request);
        let job = performed.job;

        if (job === null) {
          const planId: PlanId = performed.preview.planId;

          const apply = await new Promise<boolean>((decide) =>
            setWarning({
              preview: performed.preview,
              confirmLabel: options.confirmLabel ?? "Apply anyway",
              decide,
            }),
          );

          setWarning(null);

          if (!apply) {
            await call("discardPlan", { planId });

            return null;
          }

          job = await call("applyPlan", { planId });
        }

        const source = options.source;
        const started = job;

        if (source !== undefined) {
          setSourceJobs((current) => new Map(current).set(source, started.id));
        }

        const finished = await waitForJob(job);
        const plan = await call("getPlan", { planId: performed.preview.planId });

        if (source !== undefined) {
          setSourceJobs((current) => {
            const next = new Map(current);

            next.delete(source);

            return next;
          });

          setResults((current) => new Map(current).set(source, plan));
        }

        announce(plan, finished);

        return plan;
      } catch (error) {
        toasts.show({
          message: "That didn't work",
          detail: error instanceof Error ? error.message : String(error),
          tone: "error",
        });

        return null;
      }
    },
    [announce, toasts, waitForJob],
  );

  const undoLast = useCallback(async () => {
    const entry = undoStack.current.at(-1);

    if (entry) {
      undoStack.current = undoStack.current.slice(0, -1);
      await entry.run();

      return;
    }

    // Nothing from this session: the newest undoable plan in the journal.
    const plans = await call("listPlans", { rootId, offset: 0, limit: 20 }).catch(() => []);
    const plan = plans.find(canUndo);

    if (plan) {
      await runUndo(plan);
    } else {
      toasts.show({ message: "Nothing to undo", tone: "info" });
    }
  }, [rootId, runUndo, toasts]);

  const api = useMemo<ActionsApi>(
    () => ({
      perform,
      undoPlan: runUndo,
      pushUndo: (run) => {
        undoStack.current = [...undoStack.current.slice(-49), { planId: null, run }];
      },
      undoLast,
      resultFor: (source) => results.get(source) ?? null,
      jobFor: (source) => {
        const id = sourceJobs.get(source);

        return id === undefined ? null : (jobs.find((job) => job.id === id) ?? null);
      },
      waitForJob,
    }),
    [perform, runUndo, undoLast, results, sourceJobs, jobs, waitForJob],
  );

  return (
    <ActionsContext.Provider value={api}>
      {children}
      {warning ? (
        <Modal
          title="Before this goes ahead"
          onClose={() => warning.decide(false)}
          footer={
            <>
              <button type="button" className="ls-btn" onClick={() => warning.decide(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ls-btn ls-btn-cta"
                data-autofocus
                onClick={() => warning.decide(true)}
              >
                {warning.confirmLabel}
              </button>
            </>
          }
        >
          <ul className="space-y-2">
            {warning.preview.warnings.map((text) => (
              <li
                key={text}
                className="flex gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </ActionsContext.Provider>
  );
}
