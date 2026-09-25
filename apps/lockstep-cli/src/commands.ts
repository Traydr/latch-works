import {
  type LockstepObserver,
  type LockstepPlan,
  type LockstepRunEvent,
  planSync,
  pruneDeleted,
  pushChanges,
  doctor as runDoctorCore,
} from "@latch-works/lockstep-core";
import { formatBytes } from "@latch-works/media-domain";
import { isInteractiveTerminal } from "./options.js";
import {
  createLineReporter,
  formatPushStatus,
  formatScanStatus,
  type LineReporter,
  PushStageSchema,
} from "./progress.js";
import type { CliOptions } from "./types.js";

/** The lockstep-core entry points this module drives, injectable so tests can pass fakes. */
export interface CoreCommands {
  doctor: typeof runDoctorCore;
  planSync: typeof planSync;
  pruneDeleted: typeof pruneDeleted;
  pushChanges: typeof pushChanges;
}

export const coreCommands = {
  doctor: runDoctorCore,
  planSync,
  pruneDeleted,
  pushChanges,
} satisfies CoreCommands;

export type ExecuteCommandDeps = {
  confirmPrune?: (deleteCount: number) => Promise<boolean>;
  core?: CoreCommands;
  isInteractive?: () => boolean;
};

export async function executeCommand(
  options: CliOptions,
  deps: ExecuteCommandDeps = {},
): Promise<void> {
  const isInteractive = deps.isInteractive ?? isInteractiveTerminal;
  const confirmPrune = deps.confirmPrune ?? defaultConfirmPrune;
  const core = deps.core ?? coreCommands;
  const reporter = createLineReporter();
  const observer = createCliObserver(reporter);

  if (options.command === "doctor") {
    const result = await core.doctor(
      {
        apiToken: process.env[options.apiTokenEnv],
        apiUrl: options.apiUrl ?? process.env.LOCKSTEP_API_URL,
        sourceRoot: options.source,
      },
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

    return;
  }

  if (!options.source) {
    throw new Error("--source is required.");
  }

  if (options.command === "verify" && !options.remoteSnapshot) {
    throw new Error("--remote-snapshot is required for verify.");
  }

  const apiUrl = options.apiUrl ?? process.env.LOCKSTEP_API_URL;
  const apiToken = process.env[options.apiTokenEnv];

  if (options.command === "push" || options.command === "prune") {
    console.log(`Remote API URL: ${apiUrl ?? "not configured"}`);
    console.log(
      `Remote API token: ${apiToken ? `configured via ${options.apiTokenEnv}` : "not configured"}`,
    );

    if (!apiUrl || !apiToken) {
      console.log(`${options.command} requires a remote API URL and token.`);
      process.exitCode = 2;

      return;
    }
  }

  const remote = selectRemote(options, apiUrl, apiToken);

  if (remote.kind === "none") {
    console.warn(
      `Warning: plan is comparing against an empty remote (${remote.reason}). Every local file ` +
        `will show as an upload and no deletes can appear. ${remote.fix}`,
    );
  }

  const plan = await core.planSync(
    {
      apiToken: remote.kind === "live" ? remote.apiToken : undefined,
      apiUrl: remote.kind === "live" ? remote.apiUrl : undefined,
      hashMode: options.command === "push" ? "remote-aware" : options.hashFiles ? "all" : "none",
      remoteSnapshotPath: remote.kind === "file" ? remote.path : undefined,
      sourceRoot: options.source,
    },
    observer,
  );

  reporter.clear();
  printPlanSummary(plan, options, remote);

  if (options.command === "verify") {
    const changedItems = plan.items.filter((item) => item.action !== "keep");
    const driftCount = changedItems.length;

    if (driftCount > 0) {
      console.log("");
      console.log(`Verify failed: ${driftCount} path(s) differ from the remote snapshot.`);
      process.exitCode = 1;
    } else {
      console.log("");
      console.log("Verify passed: local archive matches the remote snapshot.");
    }

    return;
  }

  if (options.command === "plan") {
    return;
  }

  const requiredApiUrl = requireConfiguredValue(apiUrl, "Remote API URL");
  const requiredApiToken = requireConfiguredValue(apiToken, "Remote API token");

  if (options.command === "push") {
    const result = await core.pushChanges(
      {
        apiToken: requiredApiToken,
        apiUrl: requiredApiUrl,
        maxChanges: options.maxChanges,
        plan,
        sourceRoot: options.source,
        uploadConcurrency: options.uploadConcurrency,
      },
      observer,
    );

    reporter.clear();
    console.log("");

    if (result.failed > 0) {
      console.log(`Push finished: ${result.pushed} succeeded, ${result.failed} failed.`);
      process.exitCode = 1;
    } else if (result.pushed === 0) {
      console.log("Nothing to push.");
    } else {
      console.log(`Push finished: ${result.pushed} change(s) applied.`);
    }

    return;
  }

  if (options.command === "prune") {
    const deleteItems = plan.items.filter((item) => item.action === "delete");

    const itemsToPrune =
      options.maxChanges === undefined ? deleteItems : deleteItems.slice(0, options.maxChanges);

    if (itemsToPrune.length === 0) {
      console.log("");
      console.log("Nothing to prune.");

      return;
    }

    if (!options.yes) {
      if (!isInteractive()) {
        console.log("");
        console.log("Prune requires --yes in non-interactive mode.");
        process.exitCode = 1;

        return;
      }

      const confirmed = await confirmPrune(itemsToPrune.length);

      if (!confirmed) {
        console.log("");
        console.log("Prune cancelled.");
        process.exitCode = 1;

        return;
      }
    }

    // Apply the deletes printed above and just confirmed; pruneDeleted never plans again.
    const result = await core.pruneDeleted(
      {
        apiToken: requiredApiToken,
        apiUrl: requiredApiUrl,
        maxChanges: options.maxChanges,
        plan,
      },
      observer,
    );

    reporter.clear();
    console.log("");

    const skippedNote =
      result.skipped > 0 ? `, ${result.skipped} skipped (back in the source folder)` : "";

    if (result.failed > 0) {
      console.log(
        `Prune finished: ${result.pruned} succeeded${skippedNote}, ${result.failed} failed.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`Prune finished: ${result.pruned} delete(s) applied${skippedNote}.`);
    }
  }
}

/** What a plan compares the local archive against. */
type RemoteSource =
  | { kind: "file"; path: string }
  | { apiToken: string; apiUrl: string; kind: "live" }
  | { fix: string; kind: "none"; reason: string };

/**
 * A snapshot file wins when given; otherwise the live Pane View snapshot when both URL and token
 * resolve. Push and prune have already returned without both, so only plan can reach `none`.
 */
function selectRemote(
  options: CliOptions,
  apiUrl: string | undefined,
  apiToken: string | undefined,
): RemoteSource {
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
  console.log(`Skipped files: ${plan.skipped}`);
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

  const changedItems = plan.items.filter((item) => item.action !== "keep");
  const previewCount = options.command === "push" || options.command === "prune" ? 5 : 20;
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

  if (options.command === "prune" && plan.counts.delete > 0) {
    const deletesToApply =
      options.maxChanges === undefined
        ? changedItems.filter((item) => item.action === "delete")
        : changedItems.filter((item) => item.action === "delete").slice(0, options.maxChanges);

    const omittedCount = plan.counts.delete - deletesToApply.length;
    const deletePreviewLimit = 20;
    const deletePreview = deletesToApply.slice(0, deletePreviewLimit);

    console.log("");

    if (options.maxChanges !== undefined && omittedCount > 0) {
      console.log(
        `Deletes to apply: ${deletesToApply.length} of ${plan.counts.delete} (capped by --max-changes)`,
      );
    } else {
      console.log(`Deletes to apply: ${plan.counts.delete}`);
    }

    console.log(deletesToApply.length > deletePreviewLimit ? "First deletes" : "Deletes");

    for (const item of deletePreview) {
      console.log(`  delete ${item.path}`);
    }

    if (deletesToApply.length > deletePreviewLimit) {
      console.log(`  ... and ${deletesToApply.length - deletePreviewLimit} more`);
    }
  }
}

async function defaultConfirmPrune(deleteCount: number): Promise<boolean> {
  const { input } = await import("@inquirer/prompts");

  const answer = await input({
    message: `Type "prune" to delete the ${deleteCount} remote ${deleteCount === 1 ? "entry" : "entries"} listed above`,
    validate: (value) => value === "prune" || 'Type "prune" to confirm.',
  });

  return answer === "prune";
}

function createCliObserver(reporter: LineReporter): LockstepObserver {
  let _pushContext: { current: number; path: string; total: number } | null = null;

  return {
    onEvent(event: LockstepRunEvent) {
      if (event.type === "status") {
        if (event.message.includes("] hashing ") || event.message.includes("] uploading ")) {
          const match = event.message.match(/^\[(\d+)\/(\d+)\] (\w+) ([^(]+)(?: \((.+)\))?$/);
          const stage = PushStageSchema.safeParse(match?.[3]);

          if (match && stage.success) {
            const [, current, total, , itemPath, detail] = match;
            reporter.setStatus(
              formatPushStatus({
                current: Number(current),
                detail,
                path: itemPath?.trim() ?? "",
                stage: stage.data,
                total: Number(total),
              }),
            );

            return;
          }
        }

        reporter.setStatus(event.message);

        return;
      }

      if (event.type === "scan-progress") {
        reporter.setStatus(formatScanStatus(event.progress));

        return;
      }

      if (event.type === "item-success") {
        reporter.clear();
        reporter.log(`[${event.current}/${event.total}] ${event.action} ${event.path}`);
        _pushContext = null;

        return;
      }

      if (event.type === "item-skipped") {
        reporter.clear();
        reporter.log(
          `[${event.current}/${event.total}] Skipped ${event.action} ${event.path}: ${event.reason}`,
        );

        return;
      }

      if (event.type === "item-failure") {
        reporter.clear();
        reporter.log(`[${event.current}/${event.total}] Failed ${event.path}: ${event.error}`);
        _pushContext = null;
      }
    },
  };
}

function requireConfiguredValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}
