import {
  doctor as runDoctorCore,
  formatBytes,
  planSync,
  pruneDeleted,
  pushChanges,
  selectChangedItems,
  selectDeleteItems,
  type LockstepObserver,
  type LockstepPlan,
  type LockstepRunEvent,
} from "@latch-works/lockstep-core";
import { isInteractiveTerminal } from "./options.js";
import {
  createLineReporter,
  formatPushStatus,
  formatScanStatus,
  type LineReporter,
  type PushStage,
} from "./progress.js";
import type { CliOptions } from "./types.js";

export type ExecuteCommandDeps = {
  confirmPrune?: () => Promise<boolean>;
  isInteractive?: () => boolean;
};

export async function executeCommand(
  options: CliOptions,
  deps: ExecuteCommandDeps = {},
): Promise<void> {
  const isInteractive = deps.isInteractive ?? isInteractiveTerminal;
  const confirmPrune = deps.confirmPrune ?? defaultConfirmPrune;
  const reporter = createLineReporter();
  const observer = createCliObserver(reporter);

  if (options.command === "doctor") {
    const result = await runDoctorCore(
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

  const apiUrl =
    options.command === "push" || options.command === "prune"
      ? (options.apiUrl ?? process.env.LOCKSTEP_API_URL)
      : undefined;
  const apiToken =
    options.command === "push" || options.command === "prune"
      ? process.env[options.apiTokenEnv]
      : undefined;

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

  const plan = await planSync(
    {
      apiToken,
      apiUrl,
      hashFiles: options.hashFiles || options.command === "push",
      remoteSnapshotPath: options.remoteSnapshot,
      sourceRoot: options.source,
    },
    observer,
  );

  reporter.clear();
  printPlanSummary(plan, options);

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
    const result = await pushChanges(
      {
        apiToken: requiredApiToken,
        apiUrl: requiredApiUrl,
        hashFiles: true,
        maxChanges: options.maxChanges,
        plan,
        sourceRoot: options.source,
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
    const changedItems = selectChangedItems(plan.items);
    const { items: itemsToPrune } = selectDeleteItems(changedItems, options.maxChanges);

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

      const confirmed = await confirmPrune();
      if (!confirmed) {
        console.log("");
        console.log("Prune cancelled.");
        process.exitCode = 1;
        return;
      }
    }

    const result = await pruneDeleted(
      {
        apiToken: requiredApiToken,
        apiUrl: requiredApiUrl,
        maxChanges: options.maxChanges,
        plan,
        sourceRoot: options.source,
      },
      observer,
    );

    reporter.clear();
    console.log("");
    if (result.failed > 0) {
      console.log(`Prune finished: ${result.pruned} succeeded, ${result.failed} failed.`);
      process.exitCode = 1;
    } else {
      console.log(`Prune finished: ${result.pruned} delete(s) applied.`);
    }
  }
}

function printPlanSummary(plan: LockstepPlan, options: CliOptions): void {
  console.log(`Source: ${plan.sourceRoot}`);
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

  const changedItems = selectChangedItems(plan.items);
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
    const { items: deletesToApply, omittedCount } = selectDeleteItems(
      changedItems,
      options.maxChanges,
    );
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

async function defaultConfirmPrune(): Promise<boolean> {
  const { input } = await import("@inquirer/prompts");
  const answer = await input({
    message: 'Type "prune" to confirm remote deletes',
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
          if (match) {
            const [, current, total, stage, itemPath, detail] = match;
            reporter.setStatus(
              formatPushStatus({
                current: Number(current),
                detail,
                path: itemPath?.trim() ?? "",
                stage: stage as PushStage,
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
