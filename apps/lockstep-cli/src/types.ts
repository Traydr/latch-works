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
