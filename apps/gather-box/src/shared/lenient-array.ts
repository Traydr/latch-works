import { z } from "zod";

/**
 * An array whose entries are dropped when they no longer parse, and which reads as empty when the
 * value is not an array at all. Chrome storage written by an older build and third-party JSON both
 * arrive that way: one bad entry must not discard the rest.
 */
export function lenientArrayOf<Entry extends z.ZodType>(entry: Entry) {
  return z
    .array(entry.nullable().catch(null))
    .catch([])
    .transform((entries) => entries.filter((value) => value !== null));
}
