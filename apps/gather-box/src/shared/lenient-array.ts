import * as z from "zod/mini";

/**
 * An array whose entries are dropped when they no longer parse, and which reads as empty when the
 * value is not an array at all. Chrome storage written by an older build and third-party JSON both
 * arrive that way: one bad entry must not discard the rest.
 */
export function lenientArrayOf<Entry extends z.ZodMiniType>(entry: Entry) {
  return z.pipe(
    z.catch(z.array(z.catch(z.nullable(entry), null)), []),
    z.transform((entries) => entries.filter((value) => value !== null))
  );
}
