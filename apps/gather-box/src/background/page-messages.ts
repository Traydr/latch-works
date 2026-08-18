import * as z from "zod/mini";
import { OPEN_EXTENSION_MESSAGE, TRIGGER_DOWNLOAD_MESSAGE } from "../shared/runtime-messages";

/**
 * The two messages a page shortcut posts to the service worker. The schema lives here rather than
 * beside the wire constants so the always-on content script does not bundle a parser.
 */
export const GatherRuntimeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(TRIGGER_DOWNLOAD_MESSAGE), target: z.literal("background") }),
  z.object({ type: z.literal(OPEN_EXTENSION_MESSAGE), target: z.literal("background") })
]);
