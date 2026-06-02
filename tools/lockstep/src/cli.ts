#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createSyncPlan, type RemoteEntrySnapshot, scanArchive } from "@latch-works/media-index";

type Command = "plan" | "push" | "verify" | "doctor";

interface CliOptions {
  command: Command;
  hashFiles: boolean;
  remoteSnapshot?: string;
  source?: string;
}

function printHelp(): void {
  console.log(`Lockstep

Usage:
  lockstep plan --source "T:\\cloud-desktop\\media" [--hash] [--remote-snapshot snapshot.json]
  lockstep verify --source "T:\\cloud-desktop\\media" --remote-snapshot snapshot.json [--hash]
  lockstep push --source "T:\\cloud-desktop\\media" [--hash]
  lockstep doctor

Notes:
  plan and verify are read-only.
  push is scaffolded and currently stops before uploading until remote API settings are added.
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
    command,
    hashFiles: false,
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
    return;
  }

  if (!options.source) {
    throw new Error("--source is required.");
  }

  const scan = await scanArchive({
    hashFiles: options.hashFiles,
    sourceRoot: options.source,
  });
  const remote = await readRemoteSnapshot(options.remoteSnapshot);
  const plan = createSyncPlan(scan.items, remote);
  const totalBytes = scan.items.reduce((sum, item) => sum + item.size, 0);

  console.log(`Source: ${scan.sourceRoot}`);
  console.log(`Media files: ${scan.items.length}`);
  console.log(`Skipped files: ${scan.skipped}`);
  console.log(`Total size: ${formatBytes(totalBytes)}`);
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
    console.log("Push is not enabled yet. Add Pane View ingest API settings before uploads run.");
    process.exitCode = 2;
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
