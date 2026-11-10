import * as z from "zod/mini";
import {
  OPEN_EXTENSION_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE,
} from "../shared/protocol/page-shortcuts";

/**
 * The two requests a page shortcut sends. The schema lives here rather than beside the wire
 * constants so the always-on page-shortcut script does not bundle a parser.
 */
export const PageShortcutRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(TRIGGER_DOWNLOAD_MESSAGE), target: z.literal("background") }),
  z.object({ type: z.literal(OPEN_EXTENSION_MESSAGE), target: z.literal("background") }),
]);
