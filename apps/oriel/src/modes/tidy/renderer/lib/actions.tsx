import type { Job, JobId, PlanRequest, PlanSummary } from "@latch-works/glazier-core/contract";
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
import { call } from "./api";
import { useEngine } from "./engine-state";
import { formatBytes, formatCount, plural } from "./format";

/** Something the owner did that ⌘Z can take back. */
interface UndoEntry {
  /** The plans it reverses, so undoing one of them any other way drops the entry. */
  planIds: number[];
  run: () => Promise<void>;
}

interface PerformOptions {
  /** Ties the result to a place in the UI, such as an Overview row, so it can show it. */
  source?: string;
  /**
   * No toast: the view shows the result itself, as the duplicate queue does on its top bar.
   * Errors still toast, and so does an undo of it.
   */
  quiet?: boolean;
  /** Runs after the change is undone, however that happens (its Undo, ⌘Z), to show it again. */
  onUndone?: () => void;
}

interface ActionsApi {
  /**
   * Runs a plan now and reports it with a toast that offers Undo; what the plan left out is in
   * the toast's detail. Resolves with the finished plan, or null when nothing ran.
   */
  perform: (request: PlanRequest, options?: PerformOptions) => Promise<PlanSummary | null>;
  /**
   * Runs plans one after another, each drafted once the one before has finished, and reports
   * them as one change with one Undo. Each step builds its request when its turn comes, from what
   * the steps before left, or returns null to be skipped; requests that turn out to have nothing
   * to do are skipped too.
   */
  performAll: (
    steps: readonly PlanStep[],
    options: { title: string; source?: string },
  ) => Promise<PlanSummary[]>;
  undoPlan: (plan: PlanSummary, options?: UndoOptions) => Promise<boolean>;
  /**
   * Adds a non-plan change (a dismissal, a preference) to ⌘Z's history. Returns a function that
   * takes it back off, for when the change is undone some other way.
   */
  pushUndo: (run: () => Promise<void>) => () => void;
  undoLast: () => Promise<void>;
  /** The newest finished plan started from `source` this session. */
  resultFor: (source: string) => PlanSummary | null;
  /** The running job of a plan started from `source`, if any. */
  jobFor: (source: string) => Job | null;
  /** The source a running job was started from, such as "convert" or "overview:tidy". */
  sourceOf: (jobId: JobId) => string | null;
  /** Waits for a job the engine started, such as an analysis, to finish. */
  waitForJob: (job: Job) => Promise<Job>;
}

/** One step of `performAll`: builds its request when its turn comes, or null to skip. */
export type PlanStep = () => Promise<PlanRequest | null>;

/** A step whose request is known before the run starts. */
export function planned(request: PlanRequest): PlanStep {
  return async () => request;
}

interface UndoOptions {
  quiet?: boolean;
  onUndone?: () => void;
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

export function ActionsProvider({ children }: { children: ReactNode }) {
  const { jobs, rootId } = useEngine();
  const toasts = useToasts();
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

  const forgetPlans = useCallback((planIds: readonly number[]) => {
    undoStack.current = undoStack.current.filter(
      (entry) => !entry.planIds.some((id) => planIds.includes(id)),
    );

    setResults((current) => {
      const next = new Map(current);

      for (const [source, result] of current) {
        if (planIds.includes(result.id)) {
          next.delete(source);
        }
      }

      return next;
    });
  }, []);

  /** Undoes plans newest first; resolves with whether every one finished. */
  const undoPlans = useCallback(
    async (plans: readonly PlanSummary[]): Promise<boolean> => {
      for (const plan of [...plans].reverse()) {
        const finished = await waitForJob(await call("undoPlan", { planId: plan.id }));

        if (finished.state !== "done") {
          toasts.show({ message: "Undo did not finish", detail: finished.message, tone: "error" });

          return false;
        }
      }

      return true;
    },
    [toasts, waitForJob],
  );

  const runUndo = useCallback(
    async (plan: PlanSummary, options: UndoOptions = {}): Promise<boolean> => {
      try {
        const done = await undoPlans([plan]);

        forgetPlans([plan.id]);

        if (done) {
          options.onUndone?.();

          if (!options.quiet) {
            toasts.show({ message: `Undid “${plan.title}”`, tone: "info" });
          }
        }

        return done;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        toasts.show({ message: "Undo failed", detail: message, tone: "error" });

        return false;
      }
    },
    [forgetPlans, toasts, undoPlans],
  );

  const announce = useCallback(
    (plan: PlanSummary, job: Job, warnings: readonly string[], options: PerformOptions) => {
      const undo = canUndo(plan);
      const quiet = options.quiet ?? false;
      const undoThis = () => runUndo(plan, { quiet, onUndone: options.onUndone });

      if (undo) {
        undoStack.current = [
          ...undoStack.current.slice(-49),
          { planIds: [plan.id], run: async () => void (await undoThis()) },
        ];
      }

      const action = undo ? { label: "Undo", run: () => void undoThis() } : null;
      const detail = [describePlan(plan), ...warnings].filter(Boolean).join(" · ") || null;

      if (job.state === "failed") {
        toasts.show({
          message: `${plan.title}, with errors`,
          detail: job.message ?? detail,
          tone: "error",
          action,
        });

        return;
      }

      if (quiet && plan.failed === 0) {
        return;
      }

      toasts.show({
        message:
          job.state === "cancelled"
            ? `Stopped after ${formatCount(plan.done)} of ${formatCount(plan.steps)}`
            : plan.title,
        detail,
        tone: plan.failed > 0 ? "error" : "done",
        action,
      });
    },
    [toasts, runUndo],
  );

  /** Drafts, applies and waits for one plan, tracking it under `source` while it runs. */
  const run = useCallback(
    async (request: PlanRequest, source: string | undefined) => {
      const performed = await call("perform", request);
      const started = performed.job;

      if (source !== undefined) {
        setSourceJobs((current) => new Map(current).set(source, started.id));
      }

      try {
        const finished = await waitForJob(started);
        const plan = await call("getPlan", { planId: performed.preview.planId });

        return { plan, finished, warnings: performed.preview.warnings };
      } finally {
        if (source !== undefined) {
          setSourceJobs((current) => {
            const next = new Map(current);

            next.delete(source);

            return next;
          });
        }
      }
    },
    [waitForJob],
  );

  const perform = useCallback(
    async (request: PlanRequest, options: PerformOptions = {}): Promise<PlanSummary | null> => {
      try {
        const { plan, finished, warnings } = await run(request, options.source);
        const source = options.source;

        if (source !== undefined) {
          setResults((current) => new Map(current).set(source, plan));
        }

        announce(plan, finished, warnings, options);

        return plan;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        toasts.show({ message: "That didn't work", detail: message, tone: "error" });

        return null;
      }
    },
    [announce, run, toasts],
  );

  const performAll = useCallback(
    async (
      steps: readonly PlanStep[],
      options: { title: string; source?: string },
    ): Promise<PlanSummary[]> => {
      const plans: PlanSummary[] = [];
      const notes: string[] = [];

      for (const step of steps) {
        try {
          const request = await step();

          if (request === null) {
            continue;
          }

          const { plan, finished } = await run(request, options.source);

          if (plan.steps > 0) {
            plans.push(plan);
          }

          if (finished.state === "cancelled") {
            notes.push(`Stopped during “${plan.title}”`);

            break;
          }

          if (finished.state === "failed" || plan.failed > 0) {
            notes.push(`${plan.title}: ${plan.failed} failed`);
          }
        } catch (error) {
          // A step with nothing left to do (its files went in an earlier step) is not an error.
          const message = error instanceof Error ? error.message : String(error);

          if (!message.includes("nothing to do")) {
            notes.push(message);
          }
        }
      }

      const undoable = plans.filter(canUndo);

      const undoAll = async () => {
        const done = await undoPlans(undoable).catch(() => false);

        forgetPlans(undoable.map((plan) => plan.id));

        if (done) {
          toasts.show({ message: `Undid “${options.title}”`, tone: "info" });
        }
      };

      if (undoable.length > 0) {
        undoStack.current = [
          ...undoStack.current.slice(-49),
          { planIds: undoable.map((plan) => plan.id), run: undoAll },
        ];
      }

      const held = plans.reduce((sum, plan) => sum + plan.held.bytes, 0);
      const before = plans.reduce((sum, plan) => sum + plan.bytesBefore, 0);
      const after = plans.reduce((sum, plan) => sum + plan.bytesAfter, 0);

      // Nothing leaves the disk until holding is emptied, so the detail says where bytes went.
      const summary = [
        before > after ? `${formatBytes(before - after)} out` : null,
        held > 0 ? `${formatBytes(held)} in holding` : null,
        ...notes,
      ].filter(Boolean);

      toasts.show({
        message: plans.length === 0 ? "Nothing to tidy" : options.title,
        detail: summary.join(" · "),
        tone: notes.length > 0 ? "error" : plans.length === 0 ? "info" : "done",
        action: undoable.length > 0 ? { label: "Undo", run: () => void undoAll() } : null,
      });

      return plans;
    },
    [forgetPlans, run, toasts, undoPlans],
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
      performAll,
      undoPlan: runUndo,
      pushUndo: (undo) => {
        const entry: UndoEntry = { planIds: [], run: undo };

        undoStack.current = [...undoStack.current.slice(-49), entry];

        return () => {
          undoStack.current = undoStack.current.filter((candidate) => candidate !== entry);
        };
      },
      undoLast,
      resultFor: (source) => results.get(source) ?? null,
      sourceOf: (jobId) => [...sourceJobs].find(([, id]) => id === jobId)?.[0] ?? null,
      jobFor: (source) => {
        const id = sourceJobs.get(source);

        return id === undefined ? null : (jobs.find((job) => job.id === id) ?? null);
      },
      waitForJob,
    }),
    [perform, performAll, runUndo, undoLast, results, sourceJobs, jobs, waitForJob],
  );

  return <ActionsContext.Provider value={api}>{children}</ActionsContext.Provider>;
}
