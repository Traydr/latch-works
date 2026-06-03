export type Command = "plan" | "push" | "verify" | "doctor";

export interface CliOptions {
  apiTokenEnv: string;
  apiUrl?: string;
  command: Command;
  hashFiles: boolean;
  maxChanges?: number;
  remoteSnapshot?: string;
  showSkipped: boolean;
  source?: string;
  yes: boolean;
}

export interface LockstepConfigDefaults {
  hashFiles?: boolean;
  maxChanges?: number;
  showSkipped?: boolean;
}

export interface LockstepConfig {
  apiUrl?: string;
  defaults?: LockstepConfigDefaults;
  lastCommand?: Command;
  source?: string;
}
