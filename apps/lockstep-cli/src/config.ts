import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

export function parseConfig(raw: unknown): LockstepConfig {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }

  const record = raw as Record<string, unknown>;
  const config: LockstepConfig = {};

  if (typeof record.source === "string" && record.source.length > 0) {
    config.source = record.source;
  }

  if (typeof record.apiUrl === "string" && record.apiUrl.length > 0) {
    config.apiUrl = record.apiUrl;
  }

  if (
    record.lastCommand === "plan" ||
    record.lastCommand === "push" ||
    record.lastCommand === "verify" ||
    record.lastCommand === "doctor"
  ) {
    config.lastCommand = record.lastCommand;
  }

  if (typeof record.defaults === "object" && record.defaults !== null) {
    config.defaults = parseDefaults(record.defaults as Record<string, unknown>);
  }

  return config;
}

function parseDefaults(record: Record<string, unknown>): LockstepConfigDefaults {
  const defaults: LockstepConfigDefaults = {};

  if (typeof record.hashFiles === "boolean") {
    defaults.hashFiles = record.hashFiles;
  }

  if (typeof record.showSkipped === "boolean") {
    defaults.showSkipped = record.showSkipped;
  }

  if (typeof record.maxChanges === "number" && Number.isInteger(record.maxChanges)) {
    defaults.maxChanges = record.maxChanges;
  }

  if (
    typeof record.uploadConcurrency === "number" &&
    Number.isInteger(record.uploadConcurrency) &&
    record.uploadConcurrency >= 1 &&
    record.uploadConcurrency <= 8
  ) {
    defaults.uploadConcurrency = record.uploadConcurrency;
  }

  return defaults;
}

async function loadConfig(configPath: string): Promise<LockstepConfig> {
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {};
    }

    throw error;
  }
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
