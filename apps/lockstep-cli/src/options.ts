import path from "node:path";
import { UPLOAD_CONCURRENCY } from "@latch-works/lockstep-core";
import { z } from "zod";
import type { ConfigStore } from "./config.js";
import { runFullWizard, runPartialPrompts } from "./interactive.js";
import {
  type CliArgs,
  type CliOptions,
  COMMANDS,
  type Command,
  DEFAULT_API_TOKEN_ENV,
  type LockstepConfig,
  type MergedOptions,
  type MissingField,
  REQUIRED_FIELDS,
  type RememberedSettings,
  type ResolvedRun,
} from "./types.js";

function printHelp(): void {
  console.log(`Lockstep

Usage:
  lockstep
  lockstep plan --source "T:\\cloud-desktop\\media" [--api-url http://localhost:3000] [--hash] [--show-skipped]
  lockstep plan --source "T:\\cloud-desktop\\media" --remote-snapshot snapshot.json [--hash]
  lockstep verify --source "T:\\cloud-desktop\\media" --remote-snapshot snapshot.json [--hash]
  lockstep push --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--max-changes 25] [--upload-concurrency 3] [--yes]
  lockstep prune --source "T:\\cloud-desktop\\media" --api-url http://localhost:3000 [--hash] [--max-changes 25] [--yes]
  lockstep doctor [--source "T:\\cloud-desktop\\media"] [--api-url http://localhost:3000]

Notes:
  plan and verify are read-only.
  plan compares against the live Pane View snapshot when an API URL (--api-url,
    LOCKSTEP_API_URL, or the saved config) and a token are available. --remote-snapshot
    compares against a saved snapshot file instead. With neither, plan warns and compares
    against an empty remote: every file shows as an upload and no deletes appear.
  verify always compares against --remote-snapshot and exits 1 on drift.
  Snapshot files are a JSON array of {path, size, sha256?} entries, or a saved
    GET /api/sync/snapshot response ({ "entries": [...] }).
  push uploads and updates only; it never applies remote deletes. It hashes what the
    comparison needs on its own, so --hash does not change it.
  prune plans once, prints the deletes, and after confirmation (or --yes) deletes exactly
    those remote entries. A delete whose file is back in the source folder is skipped.
  Ctrl+C during push or prune finalizes the sync run as cancelled; press it again to quit at once.
  API tokens are read from LOCKSTEP_API_TOKEN, or the variable named by --api-token-env.
  --upload-concurrency bounds parallel uploads (${UPLOAD_CONCURRENCY.min}-${UPLOAD_CONCURRENCY.max}, default ${UPLOAD_CONCURRENCY.default}).
  Flags apply to the current run only. ~/.latch-works/lockstep.json remembers the source
    and API URL you last passed or chose; its "defaults" block (hashFiles, showSkipped,
    maxChanges, uploadConcurrency) is read but never written, so edit it by hand.
  --no-hash and --no-show-skipped override those defaults for one run.
  Run lockstep with no arguments for interactive mode (TTY required).
`);
}

export type ParseArgvResult =
  | { kind: "help" }
  | { kind: "invalid" }
  | { kind: "empty" }
  | { kind: "parsed"; options: CliArgs };

const CommandSchema = z.enum(COMMANDS);

export function parseArgv(argv: string[]): ParseArgvResult {
  if (argv.length === 0) {
    return { kind: "empty" };
  }

  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return { kind: "help" };
  }

  const [rawCommand, ...rest] = argv;
  const command = CommandSchema.safeParse(rawCommand);

  if (!command.success) {
    return { kind: "invalid" };
  }

  const options: CliArgs = {
    apiTokenEnv: DEFAULT_API_TOKEN_ENV,
    command: command.data,
    yes: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--source":
        options.source = requireValue(rest[index + 1], "--source");
        index += 1;
        break;
      case "--hash":
        options.hashFiles = true;
        break;
      case "--no-hash":
        options.hashFiles = false;
        break;
      case "--api-url":
        options.apiUrl = requireValue(rest[index + 1], "--api-url");
        index += 1;
        break;
      case "--api-token-env":
        options.apiTokenEnv = requireValue(rest[index + 1], "--api-token-env");
        index += 1;
        break;
      case "--max-changes":
        options.maxChanges = parsePositiveInteger(rest[index + 1], "--max-changes");
        index += 1;
        break;
      case "--upload-concurrency":
        options.uploadConcurrency = parseBoundedInteger(
          rest[index + 1],
          "--upload-concurrency",
          UPLOAD_CONCURRENCY.min,
          UPLOAD_CONCURRENCY.max,
        );
        index += 1;
        break;
      case "--show-skipped":
        options.showSkipped = true;
        break;
      case "--no-show-skipped":
        options.showSkipped = false;
        break;
      case "--remote-snapshot":
        options.remoteSnapshot = requireValue(rest[index + 1], "--remote-snapshot");
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

/**
 * A value-taking flag with nothing after it, or followed by another flag, is an error: falling
 * back to the saved or env value would point the run somewhere the user did not name.
 */
function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

export interface ResolveOptionsDeps {
  configStore: ConfigStore;
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
}

/**
 * Resolves one run's options: flags first, then env, then the config file. Only the source and
 * API URL the user passed or chose (and the wizard's command) come back as settings to remember;
 * run toggles such as `--hash` apply to this run alone.
 */
export async function resolveOptions(
  argv: string[],
  deps: ResolveOptionsDeps,
): Promise<ResolvedRun | null> {
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

    const wizard = await runFullWizard(config, env);

    return withAbsoluteSource({ ...wizard, options: commandOptions(wizard.options) });
  }

  const merged = mergeWithConfigAndEnv(parsed.options, config, env);
  const missing = getMissingFields(merged);

  const remember: RememberedSettings = {
    apiUrl: parsed.options.apiUrl,
    source: parsed.options.source,
  };

  if (missing.length === 0 || !isInteractive) {
    return withAbsoluteSource({ options: commandOptions(merged), remember });
  }

  const resolved = await runPartialPrompts(merged, missing);

  return withAbsoluteSource({
    options: commandOptions(resolved),
    remember: {
      apiUrl: missing.includes("apiUrl") ? resolved.apiUrl : remember.apiUrl,
      source: missing.includes("source") ? resolved.source : remember.source,
    },
  });
}

/** A remembered relative source would point somewhere else when the next run starts elsewhere. */
function withAbsoluteSource(run: ResolvedRun): ResolvedRun {
  const { source } = run.remember;

  return source ? { ...run, remember: { ...run.remember, source: path.resolve(source) } } : run;
}

/**
 * Flags win over env, env over the config file, and the config file over built-in defaults. The
 * only place a run reads `LOCKSTEP_*` or the token variable.
 */
export function mergeWithConfigAndEnv(
  args: CliArgs,
  config: LockstepConfig,
  env: NodeJS.ProcessEnv,
): MergedOptions {
  const defaults = config.defaults ?? {};

  return {
    ...args,
    apiToken: env[args.apiTokenEnv],
    source: args.source ?? env.LOCKSTEP_SOURCE ?? config.source,
    apiUrl: args.apiUrl ?? env.LOCKSTEP_API_URL ?? config.apiUrl,
    hashFiles: args.hashFiles ?? defaults.hashFiles ?? false,
    showSkipped: args.showSkipped ?? defaults.showSkipped ?? false,
    maxChanges: args.maxChanges ?? defaults.maxChanges,
    uploadConcurrency: args.uploadConcurrency ?? defaults.uploadConcurrency,
  };
}

export function getMissingFields(options: MergedOptions): MissingField[] {
  return REQUIRED_FIELDS[options.command].filter((field) => !options[field]);
}

function missingFieldMessage(field: MissingField, command: Command): string {
  switch (field) {
    case "source":
      return "--source is required.";
    case "remoteSnapshot":
      return `--remote-snapshot is required for ${command}.`;
    case "apiUrl":
      return `${command.charAt(0).toUpperCase()}${command.slice(1)} requires a remote API URL. Set LOCKSTEP_API_URL or pass --api-url.`;
    default: {
      const _exhaustive: never = field;

      return _exhaustive;
    }
  }
}

/** The options as their command's type, or the error for the first field it still lacks. */
function commandOptions(options: MergedOptions): CliOptions {
  const [missing] = getMissingFields(options);

  if (missing !== undefined) {
    throw new Error(missingFieldMessage(missing, options.command));
  }

  // SAFETY: getMissingFields found every field REQUIRED_FIELDS names for this command set, and
  // CliOptions is derived from that same table.
  return options as CliOptions;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
