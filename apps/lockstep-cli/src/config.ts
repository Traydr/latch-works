import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LockstepConfig, LockstepConfigDefaults, RememberedSettings } from "./types.js";

const CONFIG_FILE_NAME = "lockstep.json";

export interface ConfigStore {
  load(): Promise<LockstepConfig>;
  path: string;
  /**
   * Writes the given settings into the file and keeps every other key as the user left it.
   * Resolves `false` without touching the file when nothing would change.
   */
  remember(settings: RememberedSettings): Promise<boolean>;
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

/** The file as written, unknown and malformed keys included, so a rewrite never drops them. */
const RawConfigSchema = z.record(z.string(), z.unknown()).catch(() => ({}));

/** Node's fs rejections carry an `errno` `code`; anything else fails the parse. */
const FileSystemErrorSchema = z.object({ code: z.string() });

function defaultConfigDir(): string {
  return path.join(os.homedir(), ".latch-works");
}

export function createConfigStore(options: CreateConfigStoreOptions = {}): ConfigStore {
  const configDir = options.configDir ?? defaultConfigDir();
  const configPath = path.join(configDir, CONFIG_FILE_NAME);

  return {
    path: configPath,
    load: () => readConfigFile(configPath, LockstepConfigSchema),
    remember: (settings) => rememberSettings(configDir, configPath, settings),
  };
}

/** A missing file reads as an empty object; invalid JSON still fails the run. */
async function readConfigFile<T>(configPath: string, schema: z.ZodType<T, unknown>): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(configPath, "utf-8")));
  } catch (error) {
    if (error instanceof Error && isMissingFileError(error)) {
      return schema.parse({});
    }

    throw error;
  }
}

function isMissingFileError(error: Error): boolean {
  const parsed = FileSystemErrorSchema.safeParse(error);

  return parsed.success && parsed.data.code === "ENOENT";
}

async function rememberSettings(
  configDir: string,
  configPath: string,
  settings: RememberedSettings,
): Promise<boolean> {
  const existing = await readConfigFile(configPath, RawConfigSchema);

  const changes = Object.entries(settings).filter(
    ([key, value]) => value !== undefined && existing[key] !== value,
  );

  if (changes.length === 0) {
    return false;
  }

  const updated = { ...existing, ...Object.fromEntries(changes) };
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");

  return true;
}
