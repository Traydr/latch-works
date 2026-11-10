import { access, stat } from "node:fs/promises";
import path from "node:path";
import { confirm, input, number, select } from "@inquirer/prompts";
import { mergeWithConfigAndEnv } from "./options.js";
import {
  DEFAULT_API_TOKEN_ENV,
  type LockstepConfig,
  type MergedOptions,
  type MissingField,
  type ResolvedRun,
  WIZARD_COMMANDS,
  type WizardCommand,
} from "./types.js";

/** Wizard answers are the user's picks, so the command, source, and prompted URL are remembered. */
export async function runFullWizard(
  config: LockstepConfig,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedRun<MergedOptions>> {
  console.log("Lockstep");
  console.log("Sync your local media archive with Pane View.\n");

  const command = await select<WizardCommand>({
    message: "What would you like to do?",
    choices: WIZARD_COMMANDS,
    default: config.lastCommand ?? "plan",
  });

  const base = mergeWithConfigAndEnv(
    { apiTokenEnv: DEFAULT_API_TOKEN_ENV, command, yes: false },
    config,
    env,
  );

  if (command === "doctor") {
    if (base.source) {
      const useSource = await confirm({
        message: `Check source directory ${base.source}?`,
        default: true,
      });

      if (!useSource) {
        base.source = undefined;
      }
    } else {
      const addSource = await confirm({
        message: "Check a local source directory?",
        default: false,
      });

      if (addSource) {
        base.source = await promptSource(base.source);
      }
    }

    return { options: base, remember: { lastCommand: command, source: base.source } };
  }

  base.source = await promptSource(base.source);

  if (command === "plan") {
    base.hashFiles = await confirm({
      message: "Hash file contents? (slower on large archives, better change detection)",
      default: base.hashFiles,
    });
    base.showSkipped = await confirm({
      message: "List skipped non-media files?",
      default: base.showSkipped,
    });
  }

  if (command === "verify") {
    base.remoteSnapshot = await promptRemoteSnapshot(undefined);
    base.hashFiles = await confirm({
      message: "Hash file contents for comparison?",
      default: true,
    });
  }

  if (command === "push") {
    await configurePushOptions(base);
  }

  return {
    options: base,
    remember: {
      // Only push prompts for the URL; the other commands use the env or saved value unasked.
      apiUrl: command === "push" ? base.apiUrl : undefined,
      lastCommand: command,
      source: base.source,
    },
  };
}

export async function runPartialPrompts(
  options: MergedOptions,
  missing: MissingField[],
): Promise<MergedOptions> {
  const current = { ...options };

  for (const field of missing) {
    switch (field) {
      case "source":
        current.source = await promptSource(current.source);
        break;
      case "remoteSnapshot":
        current.remoteSnapshot = await promptRemoteSnapshot(current.remoteSnapshot);
        break;
      case "apiUrl":
        current.apiUrl = await promptApiUrl(current.apiUrl);
        break;
      default:
        break;
    }
  }

  if (current.command === "push" && !current.yes) {
    await confirmPush(current);
    current.yes = true;
  }

  if (current.command === "push") {
    if (!current.apiToken) {
      throw new Error(
        `Push requires ${current.apiTokenEnv}. Set it in your environment and run lockstep doctor.`,
      );
    }
  }

  return current;
}

async function configurePushOptions(options: MergedOptions): Promise<void> {
  options.apiUrl = await promptApiUrl(options.apiUrl);

  const tokenEnv = options.apiTokenEnv;
  const tokenConfigured = Boolean(options.apiToken);
  console.log(
    tokenConfigured
      ? `API token: configured via ${tokenEnv}`
      : `API token: not configured (set ${tokenEnv})`,
  );

  if (!tokenConfigured) {
    throw new Error(`Push requires ${tokenEnv}. Set it in your environment and retry.`);
  }

  const useCap = await confirm({
    message: "Limit the number of changes to push?",
    default: options.maxChanges !== undefined,
  });

  if (useCap) {
    options.maxChanges = await number({
      message: "Maximum changes to push",
      default: options.maxChanges ?? 25,
      min: 1,
      required: true,
    });
  } else {
    options.maxChanges = undefined;
  }

  await confirmPush(options);
  options.yes = true;
}

async function confirmPush(options: MergedOptions): Promise<void> {
  const cap =
    options.maxChanges !== undefined ? ` (max ${options.maxChanges} changes)` : " (all changes)";

  const confirmed = await confirm({
    message: `Push from ${options.source} to ${options.apiUrl}${cap}?`,
    default: false,
  });

  if (!confirmed) {
    throw new Error("Push cancelled.");
  }
}

async function promptSource(defaultValue?: string): Promise<string> {
  return input({
    message: "Local archive source directory",
    default: defaultValue,
    required: true,
    validate: async (value) => {
      try {
        await validateSourceDirectory(value);

        return true;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid source directory.";
      }
    },
  });
}

async function promptRemoteSnapshot(defaultValue?: string): Promise<string> {
  return input({
    message: "Remote snapshot JSON file",
    default: defaultValue,
    required: true,
    validate: async (value) => {
      try {
        await validateSnapshotFile(value);

        return true;
      } catch (error) {
        return error instanceof Error ? error.message : "Snapshot file not found.";
      }
    },
  });
}

async function promptApiUrl(defaultValue?: string): Promise<string> {
  return input({
    message: "Pane View API URL",
    default: defaultValue ?? "http://localhost:3000",
    required: true,
    validate: (value) => {
      try {
        new URL(value);

        return true;
      } catch {
        return "Enter a valid URL.";
      }
    },
  });
}

async function validateSourceDirectory(source: string): Promise<void> {
  const resolved = path.resolve(source);
  const sourceStat = await stat(resolved);

  if (!sourceStat.isDirectory()) {
    throw new Error(`Source is not a directory: ${resolved}`);
  }
}

async function validateSnapshotFile(snapshotPath: string): Promise<void> {
  await access(path.resolve(snapshotPath));
}
