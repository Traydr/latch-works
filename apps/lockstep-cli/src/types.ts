export const COMMANDS = ["doctor", "plan", "prune", "push", "verify"] as const;

export type Command = (typeof COMMANDS)[number];

/**
 * What the wizard offers, in its order. Prune is left out: it deletes remote entries, so it runs
 * only when named on the command line. The wizard remembers the command it ran.
 */
export const WIZARD_COMMANDS = [
  { name: "Plan — scan archive and show sync plan (read-only)", value: "plan" },
  { name: "Push — upload changes to Pane View", value: "push" },
  { name: "Verify — compare local archive to a snapshot file", value: "verify" },
  { name: "Doctor — check configuration and API connectivity", value: "doctor" },
] as const satisfies ReadonlyArray<{ name: string; value: Command }>;

export type WizardCommand = (typeof WIZARD_COMMANDS)[number]["value"];

export const DEFAULT_API_TOKEN_ENV = "LOCKSTEP_API_TOKEN";

/** One run's options, with flags, env and the config file merged, before each command's checks. */
export interface MergedOptions {
  /** The token read from `apiTokenEnv`. */
  apiToken?: string;
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

/** An option a command cannot run without, which the wizard asks for when it is missing. */
export type MissingField = "apiUrl" | "remoteSnapshot" | "source";

/**
 * What each command cannot run without, in the order the prompts ask. Push and prune reach Pane
 * View, so they need its URL as well as a source.
 */
export const REQUIRED_FIELDS = {
  doctor: [],
  plan: ["source"],
  prune: ["source", "apiUrl"],
  push: ["source", "apiUrl"],
  verify: ["source", "remoteSnapshot"],
} as const satisfies Record<Command, readonly MissingField[]>;

/** A run of `C`, holding what [`REQUIRED_FIELDS`] says it requires. The token can still be missing. */
type OptionsOf<C extends Command> = MergedOptions & { command: C } & {
  [Field in (typeof REQUIRED_FIELDS)[C][number]]: string;
};

export type RemoteRunOptions = OptionsOf<"prune" | "push">;

/** One run's options, holding what its command requires. */
export type CliOptions = { [C in Command]: OptionsOf<C> }[Command];

/**
 * What the command line said, before config and env fill the gaps. The toggles stay unset
 * unless a flag names them, so `--no-hash` can override a `defaults.hashFiles` in the config.
 */
export interface CliArgs extends Omit<MergedOptions, "apiToken" | "hashFiles" | "showSkipped"> {
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
  lastCommand?: WizardCommand;
  source?: string;
}

/**
 * The only config keys a run writes back: the archive and server the user picked, and the
 * command the wizard ran.
 */
export type RememberedSettings = Pick<LockstepConfig, "apiUrl" | "lastCommand" | "source">;

/** Options for one run, plus the settings from it that later runs should start from. */
export interface ResolvedRun<Options = CliOptions> {
  options: Options;
  remember: RememberedSettings;
}
