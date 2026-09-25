export type Command = "doctor" | "plan" | "prune" | "push" | "verify";

export interface CliOptions {
  apiTokenEnv: string;
  apiUrl?: string;
  command: Command;
  hashFiles: boolean;
  maxChanges?: number;
  remoteSnapshot?: string;
  showSkipped: boolean;
  source?: string;
  uploadConcurrency?: number;
  yes: boolean;
}

/**
 * What the command line said, before config and env fill the gaps. The toggles stay unset
 * unless a flag names them, so `--no-hash` can override a `defaults.hashFiles` in the config.
 */
export interface CliArgs extends Omit<CliOptions, "hashFiles" | "showSkipped"> {
  hashFiles?: boolean;
  showSkipped?: boolean;
}

/** Hand-edited run defaults; the CLI reads these but never writes them. */
export interface LockstepConfigDefaults {
  hashFiles?: boolean;
  maxChanges?: number;
  showSkipped?: boolean;
  uploadConcurrency?: number;
}

export interface LockstepConfig {
  apiUrl?: string;
  defaults?: LockstepConfigDefaults;
  lastCommand?: Command;
  source?: string;
}

/**
 * The only config keys a run writes back: the archive and server the user picked, and the
 * command the wizard ran.
 */
export type RememberedSettings = Pick<LockstepConfig, "apiUrl" | "lastCommand" | "source">;

/** Options for one run, plus the settings from it that later runs should start from. */
export interface ResolvedRun {
  options: CliOptions;
  remember: RememberedSettings;
}
