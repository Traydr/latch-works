#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaItem } from "@latch-works/media-domain";
import { createSyncPlan, type RemoteEntrySnapshot, scanArchive } from "@latch-works/media-index";

type Command = "plan" | "push" | "verify" | "doctor";

interface CliOptions {
  apiTokenEnv: string;
  apiUrl?: string;
  command: Command;
  hashFiles: boolean;
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
  lockstep push --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--hash]
  lockstep doctor

Notes:
  plan and verify are read-only.
  push uploads changed originals through the configured sync API.
  API tokens are read from LOCKSTEP_API_TOKEN by default.
`);
}

function parseArgs(argv: string[]): CliOptions {
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
  const scan = await scanArchive({
    hashFiles: options.hashFiles || options.command === "push",
    sourceRoot: options.source,
  });
  const remote =
    options.command === "push" && !options.remoteSnapshot && apiUrl && apiToken
      ? await fetchRemoteSnapshot(apiUrl, apiToken)
      : await readRemoteSnapshot(options.remoteSnapshot);
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
    console.log(`Remote API URL: ${apiUrl ?? "not configured"}`);
    console.log(
      `Remote API token: ${apiToken ? `configured via ${options.apiTokenEnv}` : "not configured"}`,
    );
    if (!apiUrl || !apiToken) {
      console.log("Push requires a remote API URL and token.");
      process.exitCode = 2;
      return;
    }

    const syncRun = await postJson<{ syncRunId: string }>(apiUrl, "/api/sync/runs", apiToken, {
      counts: plan.counts,
      sourceRoot: scan.sourceRoot,
    });

    let pushed = 0;
    for (const item of plan.items) {
      if (item.action === "keep") {
        continue;
      }

      if (item.action === "delete") {
        await postJson(apiUrl, "/api/sync/complete-object", apiToken, {
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
        apiToken,
        apiUrl,
        item: item.local,
        sourceRoot: scan.sourceRoot,
        syncRunId: syncRun.syncRunId,
      });
      pushed += 1;
    }

    console.log(`Pushed changes: ${pushed}`);
  }
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
  if (!item.sha256) {
    throw new Error(`Cannot push without sha256: ${item.path}`);
  }

  const uploadTarget = await postJson<{
    objectKey: string;
    uploadUrl: string | null;
  }>(apiUrl, "/api/sync/upload-url", apiToken, {
    contentType: contentTypeFor(item),
    filename: item.name,
    sha256: item.sha256,
  });

  if (uploadTarget.uploadUrl) {
    await uploadFile(
      uploadTarget.uploadUrl,
      localFilePath(sourceRoot, item.path),
      contentTypeFor(item),
    );
  }

  await postJson(apiUrl, "/api/sync/complete-object", apiToken, {
    contentType: contentTypeFor(item),
    extension: item.extension,
    filename: item.name,
    logicalPath: item.path,
    mediaType: item.mediaType,
    mtimeMs: item.mtimeMs,
    objectKey: uploadTarget.objectKey,
    sha256: item.sha256,
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
  const response = await fetch(uploadUrl, {
    body: createReadStream(filePath) as never,
    duplex: "half",
    headers: {
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
