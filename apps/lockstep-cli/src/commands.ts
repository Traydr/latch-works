import {
  doctor,
  type LockstepObserver,
  type LockstepPlan,
  type LockstepRunEvent,
  plannedChanges,
  plannedDeletes,
  planSync,
  pruneDeleted,
  pushChanges,
  type SnapshotSource,
  type SyncPlanItem,
} from "@latch-works/lockstep-core";
import { formatBytes } from "@latch-works/media-domain";
import { isInteractiveTerminal } from "./options.js";
import {
  createLineReporter,
  formatItemStage,
  formatScanStatus,
  type LineReporter,
} from "./progress.js";
import type { CliOptions, RemoteRunOptions } from "./types.js";

export type ExecuteCommandDeps = {
  /** Asks before deleting; an abort through `signal` rejects the pending prompt. */
  confirmPrune?: (deleteCount: number, signal?: AbortSignal) => Promise<boolean>;
  isInteractive?: () => boolean;
  /** Aborts the run; push and prune then finalize their sync run as cancelled before rejecting. */
  signal?: AbortSignal;
};

export async function executeCommand(
  options: CliOptions,
  deps: ExecuteCommandDeps = {},
): Promise<void> {
  const reporter = createLineReporter();
  const observer = createCliObserver(reporter);

  if (options.command === "doctor") {
    await runDoctor(options, observer, deps.signal);

    return;
  }

  if (options.command === "plan" || options.command === "verify") {
    const plan = await planAndPrint(options, reporter, observer, deps.signal);

    if (options.command === "verify") {
      printVerifyResult(plan);
    }

    return;
  }

  console.log(`Remote API URL: ${options.apiUrl}`);
  console.log(
    `Remote API token: ${options.apiToken ? `configured via ${options.apiTokenEnv}` : "not configured"}`,
  );

  if (!options.apiToken) {
    console.log(`${options.command} requires a remote API URL and token.`);
    process.exitCode = 2;

    return;
  }

  const connected: ConnectedRunOptions = { ...options, apiToken: options.apiToken };
  const plan = await planAndPrint(connected, reporter, observer, deps.signal);

  if (connected.command === "push") {
    await runPush(connected, plan, reporter, observer, deps.signal);
  } else {
    await runPrune(connected, plan, reporter, observer, deps);
  }
}

async function runDoctor(
  options: CliOptions,
  observer: LockstepObserver,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await doctor(
    { apiToken: options.apiToken, apiUrl: options.apiUrl, signal, sourceRoot: options.source },
    observer,
  );

  console.log("Lockstep doctor");
  console.log(`Node: ${process.version}`);
  console.log("Archive writes: disabled");
  console.log("Remote deletes: require explicit prune");

  for (const check of result.checks) {
    const status = check.ok ? "ok" : "failed";
    const detail = check.detail ? ` (${check.detail})` : "";
    console.log(`${check.label}: ${status}${detail}`);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function planAndPrint(
  options: Exclude<CliOptions, { command: "doctor" }>,
  reporter: LineReporter,
  observer: LockstepObserver,
  signal: AbortSignal | undefined,
): Promise<LockstepPlan> {
  const remote = selectRemote(options);

  if (remote.kind === "none") {
    console.warn(
      `Warning: plan is comparing against an empty remote (${remote.reason}). Every local file ` +
        `will show as an upload and no deletes can appear. ${remote.fix}`,
    );
  }

  const plan = await planSync(
    {
      hashMode: options.command === "push" ? "remote-aware" : options.hashFiles ? "all" : "none",
      remote,
      signal,
      sourceRoot: options.source,
    },
    observer,
  );

  reporter.clear();
  printPlanSummary(plan, options, remote);

  return plan;
}

function printVerifyResult(plan: LockstepPlan): void {
  const driftCount = plannedChanges(plan).length;

  console.log("");

  if (driftCount > 0) {
    console.log(`Verify failed: ${driftCount} path(s) differ from the remote snapshot.`);
    process.exitCode = 1;
  } else {
    console.log("Verify passed: local archive matches the remote snapshot.");
  }
}

/** Push or prune options once the token is known to be set. */
type ConnectedRunOptions = RemoteRunOptions & { apiToken: string };

async function runPush(
  options: ConnectedRunOptions,
  plan: LockstepPlan,
  reporter: LineReporter,
  observer: LockstepObserver,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await pushChanges(
    {
      apiToken: options.apiToken,
      apiUrl: options.apiUrl,
      maxChanges: options.maxChanges,
      plan,
      signal,
      uploadConcurrency: options.uploadConcurrency,
    },
    observer,
  );

  reporter.clear();
  console.log("");

  if (result.failed > 0) {
    console.log(`Push finished: ${result.applied} succeeded, ${result.failed} failed.`);
    process.exitCode = 1;
  } else if (result.applied === 0) {
    console.log("Nothing to push.");
  } else {
    console.log(`Push finished: ${result.applied} change(s) applied.`);
  }
}

async function runPrune(
  options: ConnectedRunOptions,
  plan: LockstepPlan,
  reporter: LineReporter,
  observer: LockstepObserver,
  deps: ExecuteCommandDeps,
): Promise<void> {
  const { items: itemsToPrune } = plannedDeletes(plan, options.maxChanges);

  printPruneDeletes(itemsToPrune, plan.counts.delete);

  if (itemsToPrune.length === 0) {
    console.log("");
    console.log("Nothing to prune.");

    return;
  }

  if (!options.yes) {
    if (!(deps.isInteractive ?? isInteractiveTerminal)()) {
      console.log("");
      console.log("Prune requires --yes in non-interactive mode.");
      process.exitCode = 1;

      return;
    }

    const confirmed = await (deps.confirmPrune ?? defaultConfirmPrune)(
      itemsToPrune.length,
      deps.signal,
    );

    if (!confirmed) {
      console.log("");
      console.log("Prune cancelled.");
      process.exitCode = 1;

      return;
    }
  }

  // pruneDeleted applies plannedDeletes for the same cap: exactly the list printed above.
  const result = await pruneDeleted(
    {
      apiToken: options.apiToken,
      apiUrl: options.apiUrl,
      maxChanges: options.maxChanges,
      plan,
      signal: deps.signal,
    },
    observer,
  );

  reporter.clear();
  console.log("");

  const skippedNote =
    result.skipped > 0 ? `, ${result.skipped} skipped (back in the source folder)` : "";

  if (result.failed > 0) {
    console.log(
      `Prune finished: ${result.applied} succeeded${skippedNote}, ${result.failed} failed.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`Prune finished: ${result.applied} delete(s) applied${skippedNote}.`);
  }
}

/** What a plan compares the local archive against, and why when it is nothing. */
type RemoteSource =
  | Exclude<SnapshotSource, { kind: "none" }>
  | { fix: string; kind: "none"; reason: string };

/**
 * A snapshot file wins when given; otherwise the live Pane View snapshot when both URL and token
 * resolve. Push and prune have already returned without both, so only plan can reach `none`.
 */
function selectRemote(options: CliOptions): RemoteSource {
  const { apiToken, apiUrl } = options;

  if (options.remoteSnapshot) {
    return { kind: "file", path: options.remoteSnapshot };
  }

  if (apiUrl && apiToken) {
    return { apiToken, apiUrl, kind: "live" };
  }

  const snapshotFix = "or pass --remote-snapshot with a saved snapshot file.";

  if (apiUrl) {
    return {
      fix: `Set ${options.apiTokenEnv} to compare against Pane View, ${snapshotFix}`,
      kind: "none",
      reason: `${options.apiTokenEnv} is not set, so ${apiUrl} was skipped`,
    };
  }

  const urlFix = "Pass --api-url or set LOCKSTEP_API_URL";

  return apiToken
    ? {
        fix: `${urlFix} to compare against Pane View, ${snapshotFix}`,
        kind: "none",
        reason: "no Pane View API URL is configured",
      }
    : {
        fix: `${urlFix}, with the token in ${options.apiTokenEnv}, to compare against Pane View, ${snapshotFix}`,
        kind: "none",
        reason: "no Pane View API URL or token",
      };
}

function describeRemote(remote: RemoteSource): string {
  switch (remote.kind) {
    case "file":
      return `snapshot file ${remote.path}`;
    case "live":
      return `live snapshot from ${remote.apiUrl}`;
    default:
      return `none, compared against an empty remote (${remote.reason})`;
  }
}

function printPlanSummary(plan: LockstepPlan, options: CliOptions, remote: RemoteSource): void {
  console.log(`Source: ${plan.sourceRoot}`);

  if (options.command === "plan" || options.command === "verify") {
    console.log(`Remote: ${describeRemote(remote)}`);
  }

  console.log(`Media files: ${plan.totalFiles}`);
  console.log(`Skipped files: ${plan.skippedEntries.length}`);
  console.log(`Total size: ${formatBytes(plan.totalBytes)}`);

  if (options.showSkipped && plan.skippedEntries.length > 0) {
    console.log("");
    console.log("Skipped files");

    for (const skipped of plan.skippedEntries) {
      console.log(`  ${skipped.reason.padEnd(21)} ${skipped.path}`);
    }
  }

  console.log("");
  console.log("Plan");
  console.log(`  upload: ${plan.counts.upload}`);
  console.log(`  update: ${plan.counts.update}`);
  console.log(`  keep:   ${plan.counts.keep}`);
  console.log(`  delete: ${plan.counts.delete}`);

  const changedItems = plannedChanges(plan);
  const previewCount = 20;
  const changedPreview = changedItems.slice(0, previewCount);

  if (changedPreview.length > 0 && options.command !== "push" && options.command !== "prune") {
    console.log("");
    console.log(changedItems.length > previewCount ? "First changes" : "Changes");

    for (const item of changedPreview) {
      console.log(`  ${item.action.padEnd(6)} ${item.path}`);
    }

    if (changedItems.length > previewCount) {
      console.log(`  ... and ${changedItems.length - previewCount} more`);
    }
  }
}

/**
 * Lists every delete prune will apply, with no preview limit: the confirmation that follows
 * covers exactly these entries.
 */
function printPruneDeletes(itemsToPrune: SyncPlanItem[], deleteCount: number): void {
  if (itemsToPrune.length === 0) {
    return;
  }

  console.log("");
  console.log(
    itemsToPrune.length < deleteCount
      ? `Deletes to apply: ${itemsToPrune.length} of ${deleteCount} (capped by --max-changes)`
      : `Deletes to apply: ${deleteCount}`,
  );

  for (const item of itemsToPrune) {
    console.log(`  delete ${item.path}`);
  }
}

async function defaultConfirmPrune(deleteCount: number, signal?: AbortSignal): Promise<boolean> {
  const { input } = await import("@inquirer/prompts");

  const answer = await input(
    {
      message: `Type "prune" to delete the ${deleteCount} remote ${deleteCount === 1 ? "entry" : "entries"} listed above`,
      validate: (value) => value === "prune" || 'Type "prune" to confirm.',
    },
    { signal },
  );

  return answer === "prune";
}

function createCliObserver(reporter: LineReporter): LockstepObserver {
  return {
    onEvent(event: LockstepRunEvent) {
      switch (event.type) {
        case "status":
          reporter.setStatus(event.message);
          break;
        case "warning":
          reporter.log(`Warning: ${event.message}`);
          break;
        case "scan-progress":
          reporter.setStatus(formatScanStatus(event.progress));
          break;
        case "item-stage":
          reporter.setStatus(formatItemStage(event));
          break;
        case "item-success":
          reporter.clear();
          reporter.log(`[${event.current}/${event.total}] ${event.action} ${event.path}`);
          break;
        case "item-skipped":
          reporter.clear();
          reporter.log(
            `[${event.current}/${event.total}] Skipped ${event.action} ${event.path}: ${event.reason}`,
          );
          break;
        case "item-failure":
          reporter.clear();
          reporter.log(`[${event.current}/${event.total}] Failed ${event.path}: ${event.error}`);
          break;
        default: {
          const _exhaustive: never = event;

          return _exhaustive;
        }
      }
    },
  };
}
