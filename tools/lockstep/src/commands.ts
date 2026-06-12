import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { MediaItem } from "@latch-works/media-domain";
import {
  createSyncPlan,
  type RemoteEntrySnapshot,
  type ScanArchiveProgress,
  scanArchive,
} from "@latch-works/media-index";
import {
  createLineReporter,
  formatBytes,
  formatPushStatus,
  formatScanStatus,
  type LineReporter,
  type PushStage,
} from "./progress.js";
import {
  resolveHashFiles,
  resolveLocalFilePath,
  selectChangedItemsForPush,
} from "./push-helpers.js";
import type { CliOptions } from "./types.js";

export async function executeCommand(options: CliOptions): Promise<void> {
  const reporter = createLineReporter();

  if (options.command === "doctor") {
    await runDoctor(options);
    return;
  }

  if (!options.source) {
    throw new Error("--source is required.");
  }

  if (options.command === "verify" && !options.remoteSnapshot) {
    throw new Error("--remote-snapshot is required for verify.");
  }

  const apiUrl =
    options.command === "push" ? (options.apiUrl ?? process.env.LOCKSTEP_API_URL) : undefined;
  const apiToken = options.command === "push" ? process.env[options.apiTokenEnv] : undefined;
  if (options.command === "push") {
    console.log(`Remote API URL: ${apiUrl ?? "not configured"}`);
    console.log(
      `Remote API token: ${apiToken ? `configured via ${options.apiTokenEnv}` : "not configured"}`,
    );

    if (!apiUrl || !apiToken) {
      console.log("Push requires a remote API URL and token.");
      process.exitCode = 2;
      return;
    }
  }

  let remote: RemoteEntrySnapshot[];
  if (options.command === "push" && !options.remoteSnapshot && apiUrl && apiToken) {
    reporter.setStatus("Fetching remote sync snapshot...");
    remote = await fetchRemoteSnapshot(apiUrl, apiToken);
    reporter.clear();
    reporter.log(`Remote snapshot loaded (${remote.length.toLocaleString()} entries).`);
  } else if (options.remoteSnapshot) {
    reporter.setStatus(`Loading remote snapshot from ${options.remoteSnapshot}...`);
    remote = await readRemoteSnapshot(options.remoteSnapshot);
    reporter.clear();
    reporter.log(`Remote snapshot loaded (${remote.length.toLocaleString()} entries).`);
  } else {
    remote = [];
  }

  const willHash = resolveHashFiles(options);
  reporter.setStatus(
    willHash ? "Indexing and hashing local archive..." : "Indexing local archive...",
  );
  const scan = await scanArchive({
    hashFiles: willHash,
    onProgress: createScanProgressReporter(reporter),
    sourceRoot: options.source,
  });
  reporter.clear();
  reporter.log(
    willHash
      ? `Indexed ${scan.items.length.toLocaleString()} media files (hashed).`
      : `Indexed ${scan.items.length.toLocaleString()} media files.`,
  );

  const plan = createSyncPlan(scan.items, remote);
  const totalBytes = scan.items.reduce((sum, item) => sum + item.size, 0);
  const skippedEntries = scan.skippedEntries ?? [];

  console.log(`Source: ${scan.sourceRoot}`);
  console.log(`Media files: ${scan.items.length}`);
  console.log(`Skipped files: ${scan.skipped}`);
  console.log(`Total size: ${formatBytes(totalBytes)}`);

  if (options.showSkipped && skippedEntries.length > 0) {
    console.log("");
    console.log("Skipped files");
    for (const skipped of skippedEntries) {
      console.log(`  ${skipped.reason.padEnd(21)} ${skipped.path}`);
    }
  } else if (options.showSkipped && scan.skipped > 0) {
    console.log("");
    console.log(
      "Skipped file details are unavailable. Rebuild @latch-works/media-index and retry.",
    );
  }

  console.log("");
  console.log("Plan");
  console.log(`  upload: ${plan.counts.upload}`);
  console.log(`  update: ${plan.counts.update}`);
  console.log(`  keep:   ${plan.counts.keep}`);
  console.log(`  delete: ${plan.counts.delete}`);

  const changedItems = plan.items.filter((item) => item.action !== "keep");
  const previewCount = options.command === "push" ? 5 : 20;
  const changedPreview = changedItems.slice(0, previewCount);
  if (changedPreview.length > 0 && options.command !== "push") {
    console.log("");
    console.log(changedItems.length > previewCount ? "First changes" : "Changes");
    for (const item of changedPreview) {
      console.log(`  ${item.action.padEnd(6)} ${item.path}`);
    }
    if (changedItems.length > previewCount) {
      console.log(`  ... and ${changedItems.length - previewCount} more`);
    }
  }

  if (options.command === "verify") {
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

  if (options.command === "push") {
    const requiredApiUrl = requireConfiguredValue(apiUrl, "Remote API URL");
    const requiredApiToken = requireConfiguredValue(apiToken, "Remote API token");
    const { items: itemsToPush, omittedDeleteCount } = selectChangedItemsForPush(
      changedItems,
      options.maxChanges,
    );

    if (itemsToPush.length === 0) {
      console.log("");
      console.log("Nothing to push.");
      return;
    }

    console.log("");
    if (options.maxChanges && changedItems.length > itemsToPush.length) {
      console.log(
        `Pushing ${itemsToPush.length} of ${changedItems.length} changes (capped by --max-changes).`,
      );
      if (omittedDeleteCount > 0) {
        console.log(
          `Warning: ${omittedDeleteCount} delete(s) were delayed by the cap and were not pushed.`,
        );
      }
    } else {
      console.log(`Pushing ${itemsToPush.length} change(s).`);
    }

    reporter.log("Creating sync run...");
    const syncRun = await postJson<{ syncRunId: string }>(
      requiredApiUrl,
      "/api/sync/runs",
      requiredApiToken,
      {
        counts: plan.counts,
        sourceRoot: scan.sourceRoot,
      },
    );

    let pushed = 0;
    let failed = 0;

    try {
    for (const [index, item] of itemsToPush.entries()) {
      const current = index + 1;
      const reportStage = (stage: PushStage, detail?: string) => {
        reporter.setStatus(
          formatPushStatus({
            current,
            detail,
            path: item.path,
            stage,
            total: itemsToPush.length,
          }),
        );
      };

      try {
        if (item.action === "delete") {
          reportStage("deleting");
          await postJson(requiredApiUrl, "/api/sync/complete-object", requiredApiToken, {
            action: "delete",
            logicalPath: item.path,
            syncRunId: syncRun.syncRunId,
          });
          pushed += 1;
          reporter.log(`[${current}/${itemsToPush.length}] Deleted ${item.path}`);
          continue;
        }

        if (!item.local) {
          continue;
        }

        await pushMediaItem({
          apiToken: requiredApiToken,
          apiUrl: requiredApiUrl,
          item: item.local,
          onStage: reportStage,
          sourceRoot: scan.sourceRoot,
          syncRunId: syncRun.syncRunId,
        });
        pushed += 1;
        reporter.log(`[${current}/${itemsToPush.length}] ${item.action} ${item.path}`);
      } catch (error) {
        failed += 1;
        reporter.log(
          `[${current}/${itemsToPush.length}] Failed ${item.path}: ${formatPushError(error)}`,
        );
      }
    }
    } finally {
      await postJson(
        requiredApiUrl,
        `/api/sync/runs/${syncRun.syncRunId}/complete`,
        requiredApiToken,
        {
          counts: {
            ...plan.counts,
            capped: itemsToPush.length,
            failed,
            planned: changedItems.length,
            pushed,
          },
          error: failed > 0 ? `${failed} item(s) failed during push` : undefined,
          status: failed > 0 ? "failed" : "completed",
        },
      ).catch((error) => {
        reporter.log(`Warning: failed to finalize sync run: ${formatPushError(error)}`);
      });
    }

    reporter.clear();
    console.log("");
    if (failed > 0) {
      console.log(`Push finished: ${pushed} succeeded, ${failed} failed.`);
      process.exitCode = 1;
    } else {
      console.log(`Push finished: ${pushed} change(s) applied.`);
    }
  }
}

export async function runDoctor(options: CliOptions): Promise<void> {
  console.log("Lockstep doctor");
  console.log(`Node: ${process.version}`);
  console.log("Archive writes: disabled");
  console.log("Remote deletes: planned when local paths disappear");

  const apiUrl = options.apiUrl ?? process.env.LOCKSTEP_API_URL;
  const apiToken = process.env[options.apiTokenEnv];
  console.log(`API URL: ${apiUrl ?? "not configured"}`);
  console.log(
    `API token: ${apiToken ? `configured via ${options.apiTokenEnv}` : "not configured"}`,
  );

  if (apiUrl && apiToken) {
    const reporter = createLineReporter();
    reporter.setStatus("Checking API snapshot endpoint...");
    try {
      const response = await fetch(new URL("/api/sync/snapshot", apiUrl), {
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
        method: "GET",
      });

      reporter.clear();

      if (response.ok) {
        const parsed = (await response.json()) as { entries?: unknown };
        const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
        console.log(`API snapshot: reachable (${entryCount} remote entries)`);
      } else if (response.status === 401 || response.status === 403) {
        console.log(`API snapshot: reachable but unauthorized (${response.status})`);
        process.exitCode = 1;
      } else {
        console.log(`API snapshot: failed (${response.status})`);
        process.exitCode = 1;
      }
    } catch (error) {
      reporter.clear();
      const message = error instanceof Error ? error.message : String(error);
      console.log(`API snapshot: unreachable (${message})`);
      process.exitCode = 1;
    }
  }

  if (options.source) {
    try {
      const sourceStat = await stat(options.source);
      console.log(
        `Source: ${options.source} (${sourceStat.isDirectory() ? "directory" : "not a directory"})`,
      );
      if (!sourceStat.isDirectory()) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Source: ${options.source} (missing or unreadable: ${message})`);
      process.exitCode = 1;
    }
  }
}

async function readRemoteSnapshot(filePath: string | undefined): Promise<RemoteEntrySnapshot[]> {
  if (!filePath) {
    return [];
  }

  const raw = await readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Remote snapshot must be a JSON array.");
  }

  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !("size" in entry) ||
      typeof entry.path !== "string" ||
      typeof entry.size !== "number"
    ) {
      throw new Error("Remote snapshot entries must include path and size.");
    }

    return {
      path: entry.path,
      size: entry.size,
      sha256: "sha256" in entry && typeof entry.sha256 === "string" ? entry.sha256 : undefined,
    };
  });
}

function createScanProgressReporter(reporter: LineReporter): (progress: ScanArchiveProgress) => void {
  return (progress) => {
    reporter.setStatus(formatScanStatus(progress));
  };
}

async function hashLocalFile(
  filePath: string,
  onProgress?: (bytesHashed: number, fileSize: number) => void,
): Promise<string> {
  const fileStat = await stat(filePath);
  const hash = createHash("sha256");
  let bytesHashed = 0;
  let lastReport = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesHashed += chunk.length;

      const now = Date.now();
      if (now - lastReport >= 100) {
        lastReport = now;
        onProgress?.(bytesHashed, fileStat.size);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  onProgress?.(fileStat.size, fileStat.size);
  return hash.digest("hex");
}

function requireConfiguredValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}

async function pushMediaItem({
  apiToken,
  apiUrl,
  item,
  onStage,
  sourceRoot,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  item: MediaItem;
  onStage: (stage: PushStage, detail?: string) => void;
  sourceRoot: string;
  syncRunId: string;
}): Promise<void> {
  const filePath = localFilePath(sourceRoot, item.path);
  const sha256 =
    item.sha256 ??
    (await hashLocalFile(filePath, (bytesHashed, fileSize) => {
      onStage(
        "hashing",
        `${formatBytes(bytesHashed)} / ${formatBytes(fileSize)}`,
      );
    }));

  onStage("registering", "requesting upload URL");
  const uploadTarget = await postJson<{
    objectKey: string;
    uploadUrl: string | null;
  }>(apiUrl, "/api/sync/upload-url", apiToken, {
    contentType: contentTypeFor(item),
    filename: item.name,
    sha256,
  });

  if (uploadTarget.uploadUrl) {
    await uploadFile(uploadTarget.uploadUrl, filePath, contentTypeFor(item), (bytesUploaded, total) => {
      onStage("uploading", `${formatBytes(bytesUploaded)} / ${formatBytes(total)}`);
    });
  } else {
    onStage("uploading", "skipped (storage not configured)");
  }

  onStage("registering", "recording ingest");
  await postJson(apiUrl, "/api/sync/complete-object", apiToken, {
    contentType: contentTypeFor(item),
    extension: item.extension,
    filename: item.name,
    logicalPath: item.path,
    mediaType: item.mediaType,
    mtimeMs: item.mtimeMs,
    objectKey: uploadTarget.objectKey,
    sha256,
    size: item.size,
    syncRunId,
  });
}

async function postJson<T = unknown>(
  apiUrl: string,
  route: string,
  apiToken: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(new URL(route, apiUrl), {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function fetchRemoteSnapshot(
  apiUrl: string,
  apiToken: string,
): Promise<RemoteEntrySnapshot[]> {
  const response = await fetch(new URL("/api/sync/snapshot", apiUrl), {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`/api/sync/snapshot failed with ${response.status}: ${await response.text()}`);
  }

  const parsed = (await response.json()) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Remote sync snapshot response must include an entries array.");
  }

  return parsed.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !("size" in entry) ||
      typeof entry.path !== "string" ||
      typeof entry.size !== "number"
    ) {
      throw new Error("Remote sync snapshot entries must include path and size.");
    }

    return {
      path: entry.path,
      sha256: "sha256" in entry && typeof entry.sha256 === "string" ? entry.sha256 : undefined,
      size: entry.size,
    };
  });
}

async function uploadFile(
  uploadUrl: string,
  filePath: string,
  contentType: string,
  onProgress?: (bytesUploaded: number, total: number) => void,
): Promise<void> {
  const fileStat = await stat(filePath);
  const total = fileStat.size;
  let bytesUploaded = 0;
  let lastReport = 0;

  // Count upload progress in a passthrough transform. Do not attach "data"
  // listeners to the stream passed to fetch — that consumes bytes twice and
  // breaks Content-Length matching in undici.
  const body = createReadStream(filePath).pipe(
    new Transform({
      transform(chunk, _encoding, callback) {
        bytesUploaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastReport >= 100) {
          lastReport = now;
          onProgress(bytesUploaded, total);
        }
        callback(null, chunk);
      },
    }),
  );

  const response = await fetch(uploadUrl, {
    body: Readable.toWeb(body) as BodyInit,
    duplex: "half",
    headers: {
      "Content-Length": String(total),
      "Content-Type": contentType,
    },
    method: "PUT",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    throw new Error(`Upload failed with ${response.status}: ${await response.text()}`);
  }

  onProgress?.(total, total);
}

function formatPushError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`;
  }

  return error.message;
}

function localFilePath(sourceRoot: string, archivePath: string): string {
  return resolveLocalFilePath(sourceRoot, archivePath);
}

function contentTypeFor(item: MediaItem): string {
  switch (item.extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
