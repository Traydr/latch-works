import type { CompleteSyncRunRequest, SyncRunStatus } from "@latch-works/sync-protocol";
import { abortError, formatError, toError } from "./errors.js";
import { plannedChanges } from "./push-helpers.js";
import { runQueue } from "./queue.js";
import { createSyncRun, createSyncRunBody, finalizeSyncRun } from "./remote-api.js";
import type { SyncPlanItem } from "./sync-plan.js";
import type {
  LockstepObserver,
  LockstepPlan,
  PaneViewApi,
  PushStage,
  RunSummary,
} from "./types.js";

export type RunAction = "prune" | "push";

const VOCABULARY = {
  prune: {
    applied: (count: number) => `${count} delete(s) applied`,
    failed: (count: number) => `${count} delete(s) failed during prune`,
  },
  push: {
    applied: (count: number) => `${count} item(s) pushed`,
    failed: (count: number) => `${count} item(s) failed during push`,
  },
} satisfies Record<RunAction, Record<"applied" | "failed", (count: number) => string>>;

/** What ended a run early: a cancellation, or an error that stops every remaining item. */
type Interruption = { error: Error; status: "failed" } | { reason: Error; status: "cancelled" };

export interface RunOutcome {
  applied: number;
  /** How many items the run took on, after the max-changes cap. */
  capped: number;
  failed: number;
  interruption?: Interruption;
  skipped: number;
}

/** Thrown by an item's work to stop the whole run rather than fail just that item. */
export class FatalRunError extends Error {}

export type ItemResult = { kind: "applied" } | { kind: "skipped"; reason: string };

/**
 * Every finalization attempt failed, so Pane View still shows the run as running and blocks
 * library maintenance until it is cancelled on the management page. Thrown by push and prune in
 * place of whatever else ended the run: `cause` is the cancellation reason or fatal error when
 * there was one, and the finalization error otherwise. `intendedStatus` says which.
 */
export class UnfinalizedSyncRunError extends Error {
  readonly action: RunAction;
  readonly finalizeError: Error;
  readonly intendedStatus: SyncRunStatus;
  readonly syncRunId: string;

  constructor({
    action,
    cause,
    finalizeError,
    intendedStatus,
    message,
    syncRunId,
  }: {
    action: RunAction;
    cause: Error;
    finalizeError: Error;
    intendedStatus: SyncRunStatus;
    message: string;
    syncRunId: string;
  }) {
    super(message, { cause });
    this.name = "UnfinalizedSyncRunError";
    this.action = action;
    this.finalizeError = finalizeError;
    this.intendedStatus = intendedStatus;
    this.syncRunId = syncRunId;
  }
}

function statusOf(outcome: RunOutcome): SyncRunStatus {
  return outcome.interruption?.status ?? (outcome.failed > 0 ? "failed" : "completed");
}

/** The finalize request recording how a run over `plan` ended. */
export function outcomeBody(
  action: RunAction,
  plan: LockstepPlan,
  outcome: RunOutcome,
): CompleteSyncRunRequest {
  const { interruption } = outcome;

  const error =
    interruption?.status === "cancelled"
      ? "Run cancelled by user"
      : interruption?.status === "failed"
        ? interruption.error.message
        : outcome.failed > 0
          ? VOCABULARY[action].failed(outcome.failed)
          : undefined;

  return {
    counts: {
      ...plan.counts,
      capped: outcome.capped,
      failed: outcome.failed,
      planned: plannedChanges(plan).length,
      pushed: outcome.applied,
    },
    error,
    status: statusOf(outcome),
  };
}

interface SyncRunContext {
  action: RunAction;
  api: PaneViewApi;
  observer?: LockstepObserver;
  plan: LockstepPlan;
  signal?: AbortSignal;
}

/**
 * One sync run's life on the server, shared by push and prune: open it, apply the items, then
 * finish it, which records the outcome and turns it into the run's summary or error.
 */
export class SyncRun {
  private constructor(
    private readonly context: SyncRunContext,
    readonly syncRunId: string,
  ) {}

  /**
   * A cancel does not abort creation (see `createSyncRun`); the run then applies nothing and
   * finishes as cancelled.
   */
  static async open(context: SyncRunContext): Promise<SyncRun> {
    context.observer?.onEvent({ type: "status", message: "Creating sync run..." });

    const { syncRunId } = await createSyncRun({
      api: context.api,
      body: createSyncRunBody(context.plan),
      signal: context.signal,
    });

    return new SyncRun(context, syncRunId);
  }

  /**
   * Runs `work` for each item, `concurrency` at once, and reports each one's result. An item's
   * error fails that item; an abort or a `FatalRunError` stops the run once the items in flight
   * have finished.
   */
  async apply<T extends SyncPlanItem>(
    items: T[],
    concurrency: number,
    work: (
      item: T,
      report: (stage: PushStage, bytes?: { done: number; total: number }) => void,
    ) => Promise<ItemResult>,
  ): Promise<RunOutcome> {
    const { observer, signal } = this.context;
    const total = items.length;
    let applied = 0;
    let failed = 0;
    let skipped = 0;
    let stopError: Error | undefined;

    try {
      await runQueue({
        concurrency,
        signal,
        tasks: items.map((item, index) => ({ current: index + 1, item })),
        work: async ({ current, item }) => {
          const position = { action: item.action, current, path: item.path, total };

          try {
            const result = await work(item, (stage, bytes) => {
              observer?.onEvent({ type: "item-stage", ...position, bytes, stage });
            });

            if (result.kind === "skipped") {
              skipped += 1;
              observer?.onEvent({ type: "item-skipped", ...position, reason: result.reason });
            } else {
              applied += 1;
              observer?.onEvent({ type: "item-success", ...position });
            }
          } catch (error) {
            if (signal?.aborted || error instanceof FatalRunError) {
              throw error;
            }

            failed += 1;
            observer?.onEvent({
              type: "item-failure",
              ...position,
              error: formatError(toError(error)),
            });
          }
        },
      });
    } catch (error) {
      stopError = toError(error);
    }

    // Decided once, after the queue: the server and the caller must agree on how the run ended.
    const interruption: Interruption | undefined = signal?.aborted
      ? { reason: stopError ?? abortError(signal), status: "cancelled" }
      : stopError
        ? { error: stopError, status: "failed" }
        : undefined;

    return { applied, capped: total, failed, interruption, skipped };
  }

  /**
   * Records the outcome, retrying a failed attempt, then returns the summary or throws what ended
   * the run. A run left unfinalized outranks a cancellation or a fatal error: it is the one the
   * user must act on.
   */
  async finish(outcome: RunOutcome): Promise<RunSummary> {
    const { action, api, observer, plan } = this.context;

    const finalizeError = await finalizeSyncRun({
      api,
      body: outcomeBody(action, plan, outcome),
      onRetry: (error) => {
        observer?.onEvent({
          type: "warning",
          message: `failed to finalize sync run, retrying: ${formatError(error)}`,
        });
      },
      syncRunId: this.syncRunId,
    });

    const { interruption } = outcome;

    if (finalizeError) {
      observer?.onEvent({
        type: "warning",
        message: `failed to finalize sync run: ${formatError(finalizeError)}`,
      });

      throw this.unfinalized(outcome, finalizeError);
    }

    if (interruption?.status === "cancelled") {
      throw interruption.reason;
    }

    if (interruption?.status === "failed") {
      throw interruption.error;
    }

    return {
      action,
      applied: outcome.applied,
      failed: outcome.failed,
      skipped: outcome.skipped,
      status: statusOf(outcome),
    };
  }

  private unfinalized(outcome: RunOutcome, finalizeError: Error): UnfinalizedSyncRunError {
    const { interruption } = outcome;
    const done = VOCABULARY[this.context.action].applied(outcome.applied);

    const ending =
      interruption?.status === "cancelled"
        ? `Run cancelled after ${done}`
        : interruption?.status === "failed"
          ? `${interruption.error.message} Stopped after ${done}`
          : done;

    return new UnfinalizedSyncRunError({
      action: this.context.action,
      cause:
        interruption?.status === "cancelled"
          ? interruption.reason
          : interruption?.status === "failed"
            ? interruption.error
            : finalizeError,
      finalizeError,
      intendedStatus: statusOf(outcome),
      message:
        `${ending}, but sync run ${this.syncRunId} could not be finalized: ` +
        `${formatError(finalizeError)}. ` +
        "Pane View shows it as running until it is cancelled on the management page.",
      syncRunId: this.syncRunId,
    });
  }
}
