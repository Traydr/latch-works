#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "@latch-works/media-domain";
import {
  createSyncPlan,
  type RemoteEntrySnapshot,
  type ScanArchiveProgress,
  scanArchive,
} from "@latch-works/media-index";

type Command = "plan" | "push" | "verify" | "doctor";

interface CliOptions {
  apiTokenEnv: string;
  apiUrl?: string;
  command: Command;
  hashFiles: boolean;
  maxChanges?: number;
  remoteSnapshot?: string;
  showSkipped: boolean;
  source?: string;
}

function printHelp(): void {
  console.log(`Lockstep

Usage:
  lockstep plan --source "T:\\cloud-desktop\\media" [--hash] [--remote-snapshot snapshot.json]
  lockstep plan --source "T:\\cloud-desktop\\media" --show-skipped
  lockstep verify --source "T:\\cloud-desktop\\media" --remote-snapshot snapshot.json [--hash]
  lockstep push --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--hash] [--max-changes 25]
  lockstep doctor

Notes:
  plan and verify are read-only.
  push uploads changed originals through the configured sync API.
  API tokens are read from LOCKSTEP_API_TOKEN by default.
`);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  const [rawCommand, ...rest] = argv;
  const command = rawCommand as Command | undefined;

  if (!command || !["plan", "push", "verify", "doctor"].includes(command)) {
    printHelp();
    process.exit(command ? 1 : 0);
  }

  const options: CliOptions = {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    command,
    hashFiles: false,
    showSkipped: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--source":
        options.source = rest[index + 1];
        index += 1;
        break;
      case "--hash":
        options.hashFiles = true;
        break;
      case "--api-url":
        options.apiUrl = rest[index + 1];
        index += 1;
        break;
      case "--api-token-env":
        options.apiTokenEnv = rest[index + 1] ?? options.apiTokenEnv;
        index += 1;
        break;
      case "--max-changes":
        options.maxChanges = parsePositiveInteger(rest[index + 1], "--max-changes");
        index += 1;
        break;
      case "--show-skipped":
        options.showSkipped = true;
        break;
      case "--remote-snapshot":
        options.remoteSnapshot = rest[index + 1];
        index += 1;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
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

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function createScanProgressReporter(): (progress: ScanArchiveProgress) => void {
  let lastReport = 0;

  return (progress) => {
    const now = Date.now();
    if (now - lastReport < 2000) {
      return;
    }

    lastReport = now;
    if (progress.stage === "hashing") {
      console.error(
        `Hashing ${progress.path} (${formatBytes(progress.bytesHashed)} / ${formatBytes(
          progress.fileSize,
        )}); found ${progress.filesFound} media, skipped ${progress.skipped}`,
      );
      return;
    }

    console.error(
      `Scanning archive; found ${progress.filesFound} media, skipped ${progress.skipped}`,
    );
  };
}

async function hashLocalFile(filePath: string, label: string): Promise<string> {
  const hash = createHash("sha256");
  let bytesHashed = 0;
  let lastReport = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesHashed += chunk.length;

      const now = Date.now();
      if (now - lastReport >= 2000) {
        lastReport = now;
        console.error(`Hashing selected file ${label}; hashed ${formatBytes(bytesHashed)}`);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "doctor") {
    console.log("Lockstep doctor");
    console.log(`Node: ${process.version}`);
    console.log("Archive writes: disabled");
    console.log("Remote deletes: planned when local paths disappear");
    console.log(`API URL: ${process.env.LOCKSTEP_API_URL ?? "not configured"}`);
    console.log(`API token: ${process.env.LOCKSTEP_API_TOKEN ? "configured" : "not configured"}`);
    return;
  }

  if (!options.source) {
    throw new Error("--source is required.");
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

    if (!options.remoteSnapshot) {
      console.error("Fetching remote sync snapshot...");
    }
  }

  const remote =
    options.command === "push" && !options.remoteSnapshot && apiUrl && apiToken
      ? await fetchRemoteSnapshot(apiUrl, apiToken)
      : await readRemoteSnapshot(options.remoteSnapshot);

  console.error(
    options.command === "push" && options.maxChanges
      ? "Scanning local archive before capped push..."
      : options.command === "push"
        ? "Scanning and hashing local archive before push..."
        : "Scanning local archive...",
  );
  const scan = await scanArchive({
    hashFiles: options.hashFiles || (options.command === "push" && !options.maxChanges),
    onProgress: createScanProgressReporter(),
    sourceRoot: options.source,
  });
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

  const changed = plan.items.filter((item) => item.action !== "keep").slice(0, 20);
  if (changed.length > 0) {
    console.log("");
    console.log("First changes");
    for (const item of changed) {
      console.log(`  ${item.action.padEnd(6)} ${item.path}`);
    }
  }

  if (options.command === "push") {
    console.log("");
    const requiredApiUrl = requireConfiguredValue(apiUrl, "Remote API URL");
    const requiredApiToken = requireConfiguredValue(apiToken, "Remote API token");
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
    const changedItems = plan.items.filter((item) => item.action !== "keep");
    const itemsToPush = options.maxChanges
      ? changedItems.slice(0, options.maxChanges)
      : changedItems;

    if (options.maxChanges && changedItems.length > itemsToPush.length) {
      console.log(
        `Limiting push to first ${itemsToPush.length} of ${changedItems.length} changes.`,
      );
    }

    for (const item of itemsToPush) {
      if (item.action === "delete") {
        await postJson(requiredApiUrl, "/api/sync/complete-object", requiredApiToken, {
          action: "delete",
          logicalPath: item.path,
          syncRunId: syncRun.syncRunId,
        });
        pushed += 1;
        continue;
      }

      if (!item.local) {
        continue;
      }

      await pushMediaItem({
        apiToken: requiredApiToken,
        apiUrl: requiredApiUrl,
        item: item.local,
        sourceRoot: scan.sourceRoot,
        syncRunId: syncRun.syncRunId,
      });
      pushed += 1;
    }

    console.log(`Pushed changes: ${pushed}`);
  }
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
  sourceRoot,
  syncRunId,
}: {
  apiToken: string;
  apiUrl: string;
  item: MediaItem;
  sourceRoot: string;
  syncRunId: string;
}): Promise<void> {
  const filePath = localFilePath(sourceRoot, item.path);
  const sha256 = item.sha256 ?? (await hashLocalFile(filePath, item.path));

  const uploadTarget = await postJson<{
    objectKey: string;
    uploadUrl: string | null;
  }>(apiUrl, "/api/sync/upload-url", apiToken, {
    contentType: contentTypeFor(item),
    filename: item.name,
    sha256,
  });

  if (uploadTarget.uploadUrl) {
    await uploadFile(uploadTarget.uploadUrl, filePath, contentTypeFor(item));
  }

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

async function uploadFile(uploadUrl: string, filePath: string, contentType: string): Promise<void> {
  const fileStat = await stat(filePath);
  const response = await fetch(uploadUrl, {
    body: createReadStream(filePath) as never,
    duplex: "half",
    headers: {
      "Content-Length": String(fileStat.size),
      "Content-Type": contentType,
    },
    method: "PUT",
  } as RequestInit & { duplex: "half" });

  if (!response.ok) {
    throw new Error(`Upload failed with ${response.status}: ${await response.text()}`);
  }
}

function localFilePath(sourceRoot: string, archivePath: string): string {
  return path.join(sourceRoot, ...archivePath.split("/"));
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

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
