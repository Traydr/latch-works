import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Command, LockstepConfig, LockstepConfigDefaults } from "./types.js";

const CONFIG_FILE_NAME = "lockstep.json";

export interface ConfigStore {
  load(): Promise<LockstepConfig>;
  path: string;
  save(partial: LockstepConfig): Promise<void>;
}

export interface CreateConfigStoreOptions {
  configDir?: string;
}

/** Each field falls back to absent so one malformed key never discards the rest of the file. */
const LockstepConfigDefaultsSchema = z.object({
  hashFiles: z.boolean().optional().catch(undefined),
  maxChanges: z.number().int().optional().catch(undefined),
  showSkipped: z.boolean().optional().catch(undefined),
  uploadConcurrency: z.number().int().min(1).max(8).optional().catch(undefined),
}) satisfies z.ZodType<LockstepConfigDefaults, unknown>;

const LockstepConfigSchema = z
  .object({
    apiUrl: z.string().min(1).optional().catch(undefined),
    defaults: LockstepConfigDefaultsSchema.optional().catch(undefined),
    lastCommand: z.enum(["doctor", "plan", "push", "verify"]).optional().catch(undefined),
    source: z.string().min(1).optional().catch(undefined),
  })
  .catch(() => ({})) satisfies z.ZodType<LockstepConfig, unknown>;

export function defaultConfigDir(): string {
  return path.join(os.homedir(), ".latch-works");
}

export function createConfigStore(options: CreateConfigStoreOptions = {}): ConfigStore {
  const configDir = options.configDir ?? defaultConfigDir();
  const configPath = path.join(configDir, CONFIG_FILE_NAME);

  return {
    path: configPath,
    load: () => loadConfig(configPath),
    save: (partial) => saveConfig(configDir, configPath, partial),
  };
}

/** Parses the contents of `lockstep.json`; anything that is not a config object reads as empty. */
export function parseConfig(contents: string): LockstepConfig {
  return LockstepConfigSchema.parse(JSON.parse(contents));
}

/** Node's fs rejections carry an `errno` `code`; anything else fails the parse. */
const FileSystemErrorSchema = z.object({ code: z.string() });

async function loadConfig(configPath: string): Promise<LockstepConfig> {
  try {
    return parseConfig(await readFile(configPath, "utf-8"));
  } catch (error) {
    if (error instanceof Error && isMissingFileError(error)) {
      return {};
    }

    throw error;
  }
}

function isMissingFileError(error: Error): boolean {
  const parsed = FileSystemErrorSchema.safeParse(error);
  return parsed.success && parsed.data.code === "ENOENT";
}

async function saveConfig(
  configDir: string,
  configPath: string,
  partial: LockstepConfig,
): Promise<void> {
  const existing = await loadConfig(configPath);
  const merged: LockstepConfig = {
    ...existing,
    ...partial,
    defaults: {
      ...existing.defaults,
      ...partial.defaults,
    },
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}

export function configFromOptions(options: {
  apiUrl?: string;
  command: Command;
  hashFiles: boolean;
  maxChanges?: number;
  showSkipped: boolean;
  source?: string;
  uploadConcurrency?: number;
}): LockstepConfig {
  return {
    apiUrl: options.apiUrl,
    lastCommand: options.command,
    source: options.source,
    defaults: {
      hashFiles: options.hashFiles,
      maxChanges: options.maxChanges,
      showSkipped: options.showSkipped,
      uploadConcurrency: options.uploadConcurrency,
    },
  };
}
