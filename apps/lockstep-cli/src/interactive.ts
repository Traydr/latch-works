import { confirm, input, number, select } from "@inquirer/prompts";
import type { MissingField } from "./options.js";
import { validateSnapshotFile, validateSourceDirectory } from "./options.js";
import type { CliOptions, Command, LockstepConfig } from "./types.js";

export async function runFullWizard(
  config: LockstepConfig,
  env: NodeJS.ProcessEnv,
): Promise<CliOptions> {
  console.log("Lockstep");
  console.log("Sync your local media archive with Pane View.\n");

  const command = await select<Command>({
    message: "What would you like to do?",
    choices: [
      { name: "Plan — scan archive and show sync plan (read-only)", value: "plan" },
      { name: "Push — upload changes to Pane View", value: "push" },
      { name: "Verify — compare local archive to a snapshot file", value: "verify" },
      { name: "Doctor — check configuration and API connectivity", value: "doctor" },
    ],
    default: config.lastCommand ?? "plan",
  });

  const base: CliOptions = {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    command,
    hashFiles: config.defaults?.hashFiles ?? false,
    maxChanges: config.defaults?.maxChanges,
    showSkipped: config.defaults?.showSkipped ?? false,
    yes: false,
    source: env.LOCKSTEP_SOURCE ?? config.source,
    apiUrl: env.LOCKSTEP_API_URL ?? config.apiUrl,
  };

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

    return base;
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
    await configurePushOptions(base, env);
  }

  return base;
}

export async function runPartialPrompts(
  options: CliOptions,
  missing: MissingField[],
  config: LockstepConfig,
  env: NodeJS.ProcessEnv,
): Promise<CliOptions> {
  let current = { ...options };

  for (const field of missing) {
    switch (field) {
      case "source":
        current.source = await promptSource(
          current.source ?? env.LOCKSTEP_SOURCE ?? config.source,
        );
        break;
      case "remoteSnapshot":
        current.remoteSnapshot = await promptRemoteSnapshot(current.remoteSnapshot);
        break;
      case "apiUrl":
        current.apiUrl = await promptApiUrl(current.apiUrl ?? env.LOCKSTEP_API_URL ?? config.apiUrl);
        break;
      default:
        break;
    }
  }

  if (current.command === "push" && !current.yes) {
    await confirmPush(current, env);
    current.yes = true;
  }

  if (current.command === "push") {
    const token = env[current.apiTokenEnv];
    if (!token) {
      throw new Error(
        `Push requires ${current.apiTokenEnv}. Set it in your environment and run lockstep doctor.`,
      );
    }
  }

  return current;
}

async function configurePushOptions(options: CliOptions, env: NodeJS.ProcessEnv): Promise<void> {
  options.apiUrl = await promptApiUrl(options.apiUrl);

  const tokenEnv = options.apiTokenEnv;
  const tokenConfigured = Boolean(env[tokenEnv]);
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

  await confirmPush(options, env);
  options.yes = true;
}

async function confirmPush(options: CliOptions, env: NodeJS.ProcessEnv): Promise<void> {
  const apiUrl = options.apiUrl ?? env.LOCKSTEP_API_URL;
  const cap =
    options.maxChanges !== undefined ? ` (max ${options.maxChanges} changes)` : " (all changes)";

  const confirmed = await confirm({
    message: `Push from ${options.source} to ${apiUrl}${cap}?`,
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
