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
]);

export type ShellCommand = z.infer<typeof ShellCommandSchema>;

export const ShellChannels = {
  /** main → window: a {@link ShellCommand}. */
  command: "oriel:command",
  /** window → main: the {@link ModeId} now showing, so the menu and title follow it. */
  setMode: "oriel:set-mode",
} as const;

/** The shell's bridge, `window.oriel`. */
export interface OrielBridge {
  platform: NodeJS.Platform;
  setMode(mode: ModeId): void;
  onCommand(listener: (command: ShellCommand) => void): () => void;
}
