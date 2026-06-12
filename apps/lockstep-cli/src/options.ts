import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { ConfigStore } from "./config.js";
import { runFullWizard, runPartialPrompts } from "./interactive.js";
import type { CliOptions, Command, LockstepConfig } from "./types.js";

export function printHelp(): void {
  console.log(`Lockstep

Usage:
  lockstep
  lockstep plan --source "T:\\cloud-desktop\\media" [--hash] [--remote-snapshot snapshot.json]
  lockstep plan --source "T:\\cloud-desktop\\media" --show-skipped
  lockstep verify --source "T:\\cloud-desktop\\media" --remote-snapshot snapshot.json [--hash]
  lockstep push --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--hash] [--max-changes 25] [--yes]
  lockstep prune --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--max-changes 25] [--yes]
  lockstep doctor [--source "T:\\cloud-desktop\\media"]

Notes:
  plan and verify are read-only.
  push uploads and updates only; it never applies remote deletes.
  prune applies planned remote deletes explicitly; confirmation or --yes is required.
  API tokens are read from LOCKSTEP_API_TOKEN by default.
  Run lockstep with no arguments for interactive mode (TTY required).
`);
}

export type ParseArgvResult =
  | { kind: "help" }
  | { kind: "invalid" }
  | { kind: "empty" }
  | { kind: "parsed"; options: CliOptions };

const COMMANDS = new Set<Command>(["doctor", "plan", "prune", "push", "verify"]);

export function parseArgv(argv: string[]): ParseArgvResult {
  if (argv.length === 0) {
    return { kind: "empty" };
  }

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return { kind: "help" };
  }

  const [rawCommand, ...rest] = argv;
  if (!rawCommand || !COMMANDS.has(rawCommand as Command)) {
    return { kind: "invalid" };
  }

  const options: CliOptions = {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    command: rawCommand as Command,
    hashFiles: false,
    showSkipped: false,
    yes: false,
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
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        return { kind: "help" };
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { kind: "parsed", options };
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export interface ResolveOptionsDeps {
  configStore: ConfigStore;
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
}

export async function resolveOptions(
  argv: string[],
  deps: ResolveOptionsDeps,
): Promise<CliOptions | null> {
  const parsed = parseArgv(argv);
  const env = deps.env ?? process.env;
  const isInteractive = deps.isInteractive ?? isInteractiveTerminal();
  const config = await deps.configStore.load();

  if (parsed.kind === "help") {
    printHelp();
    return null;
  }

  if (parsed.kind === "invalid") {
    printHelp();
    process.exitCode = 1;
    return null;
  }

  if (parsed.kind === "empty") {
    if (!isInteractive) {
      printHelp();
      return null;
    }

    return runFullWizard(config, env);
  }

  const merged = mergeWithConfigAndEnv(parsed.options, config, env);
  const missing = getMissingFields(merged, env);

  if (missing.length === 0) {
    return merged;
  }

  if (!isInteractive) {
    throwMissingFieldError(missing[0]!);
  }

  const resolved = await runPartialPrompts(merged, missing, config, env);
  return resolved;
}

export function mergeWithConfigAndEnv(
  options: CliOptions,
  config: LockstepConfig,
  env: NodeJS.ProcessEnv,
): CliOptions {
  const defaults = config.defaults ?? {};

  return {
    ...options,
    source: options.source ?? env.LOCKSTEP_SOURCE ?? config.source,
    apiUrl: options.apiUrl ?? env.LOCKSTEP_API_URL ?? config.apiUrl,
    hashFiles: options.hashFiles || defaults.hashFiles === true,
    showSkipped: options.showSkipped || defaults.showSkipped === true,
    maxChanges: options.maxChanges ?? defaults.maxChanges,
  };
}

export type MissingField = "source" | "remoteSnapshot" | "apiUrl";

export function getMissingFields(options: CliOptions, env: NodeJS.ProcessEnv = process.env): MissingField[] {
  const missing: MissingField[] = [];

  if (options.command !== "doctor" && !options.source) {
    missing.push("source");
  }

  if (options.command === "verify" && !options.remoteSnapshot) {
    missing.push("remoteSnapshot");
  }

  if (
    (options.command === "push" || options.command === "prune") &&
    !(options.apiUrl ?? env.LOCKSTEP_API_URL)
  ) {
    missing.push("apiUrl");
  }

  return missing;
}

function throwMissingFieldError(field: MissingField): never {
  switch (field) {
    case "source":
      throw new Error("--source is required.");
    case "remoteSnapshot":
      throw new Error("--remote-snapshot is required for verify.");
    case "apiUrl":
      throw new Error("Push requires a remote API URL. Set LOCKSTEP_API_URL or pass --api-url.");
    default:
      throw new Error("Missing required option.");
  }
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function validateSourceDirectory(source: string): Promise<string> {
  const resolved = path.resolve(source);
  const sourceStat = await stat(resolved);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source is not a directory: ${resolved}`);
  }

  return resolved;
}

export async function validateSnapshotFile(snapshotPath: string): Promise<string> {
  const resolved = path.resolve(snapshotPath);
  await access(resolved);
  return resolved;
}
