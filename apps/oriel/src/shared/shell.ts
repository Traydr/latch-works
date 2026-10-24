/**
 * What crosses between Oriel's main process and its window for the shell itself: which mode is
 * showing, and the commands the app menu sends. Each mode keeps its own channels beside these.
 */
import { z } from "zod";

/** Whatever crosses IPC before it is parsed: structured-clone data, which here is always JSON. */
const JsonSchema = z.json();

export type Json = z.infer<typeof JsonSchema>;

/** The three modes, in the switcher's order. */
export const ModeIdSchema = z.enum(["view", "tidy", "sync"]);

export type ModeId = z.infer<typeof ModeIdSchema>;

export const MODE_IDS = ModeIdSchema.options;

export const MODE_LABELS = {
  view: "View",
  tidy: "Tidy",
  sync: "Sync",
} as const satisfies Record<ModeId, string>;

/** Commands the main process sends the window, from the app menu. */
export const ShellCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mode"), mode: ModeIdSchema }),
  z.object({ type: z.literal("toggle-sidebar") }),
  z.object({ type: z.literal("settings") }),
]);

export type ShellCommand = z.infer<typeof ShellCommandSchema>;

export const ShellChannels = {
  /** main → window: a {@link ShellCommand}. */
  command: "oriel:command",
  /** window → main: the {@link ModeId} now showing, so the menu and title follow it. */
  setMode: "oriel:set-mode",
  /** window → main, answered: the app's version and data folder, for Settings. */
  about: "oriel:about",
  /** window → main: File › Import from the Old Apps…, from Settings. */
  importOldApps: "oriel:import-old-apps",
  /** window → main: show `~/.latch-works` in Finder or Explorer. */
  revealDataFolder: "oriel:reveal-data-folder",
  /** window → main, answered: every {@link KnownFolder}. */
  folders: "oriel:folders",
  /**
   * window → main, answered: open a file or folder another mode showed in View. Main opens it
   * only inside a {@link KnownFolder}, since View scans only folders the owner chose.
   */
  openInView: "oriel:open-in-view",
  /** window → main, answered: the {@link FirstRun} facts the welcome shows. */
  firstRun: "oriel:first-run",
  /** window → main, answered: the native folder dialog; main keeps the folder chosen. */
  chooseArchive: "oriel:choose-archive",
  /** window → main, answered: an {@link ArchiveSetup} for the chosen folder; the problems met. */
  setUpArchive: "oriel:set-up-archive",
  /** window → main: the welcome is done, and does not show again. */
  finishWelcome: "oriel:finish-welcome",
} as const;

export const AboutSchema = z.object({ version: z.string(), dataFolder: z.string() });

export type About = z.infer<typeof AboutSchema>;

/**
 * A folder one of the modes works on: View's last folder, a folder Tidy tidies, a Sync profile's
 * archive, or one the old apps used. Each mode keeps its own list; the shell only proposes these
 * to the modes that do not have them.
 */
export const KnownFolderSchema = z.object({
  path: z.string(),
  /** The modes that use it; none for a folder only the old apps had. */
  modes: z.array(ModeIdSchema),
});

export type KnownFolder = z.infer<typeof KnownFolderSchema>;

export const FirstRunSchema = z.object({
  /** Whether the welcome shows: once, on the owner's first start. */
  show: z.boolean(),
  /** What the first start brought over from the old apps, in one line, or null. */
  migrated: z.string().nullable(),
  /** No folder came over, so the welcome asks for one. */
  needsFolder: z.boolean(),
  /** No Sync profile came over, so the welcome offers to connect Pane View. */
  needsServer: z.boolean(),
});

export type FirstRun = z.infer<typeof FirstRunSchema>;

/** What to do with the folder the welcome chose: View always opens it. */
export const ArchiveSetupSchema = z.object({
  tidy: z.boolean(),
  /** A Sync profile for the folder on this Pane View server, or none. */
  server: z.object({ apiUrl: z.string().min(1), token: z.string() }).nullable(),
});

type ArchiveSetup = z.infer<typeof ArchiveSetupSchema>;

/** The shell's bridge, `window.oriel`. */
export interface OrielBridge {
  platform: NodeJS.Platform;
  setMode(mode: ModeId): void;
  onCommand(listener: (command: ShellCommand) => void): () => void;
  about(): Promise<About>;
  importOldApps(): void;
  revealDataFolder(): void;
  folders(): Promise<KnownFolder[]>;
  /** Whether View opened `path`, a file (opened in the viewer) or a folder. */
  openInView(path: string): Promise<boolean>;
  firstRun(): Promise<FirstRun>;
  /** The folder the owner chose in the native dialog, or null if they cancelled. */
  chooseArchive(): Promise<string | null>;
  setUpArchive(setup: ArchiveSetup): Promise<string[]>;
  finishWelcome(): void;
}
