import type { z } from "zod";

/**
 * Parse JSON text straight into a schema. Null when the text is not JSON or
 * the value does not fit — the two failures every caller treats the same way
 * (localStorage snapshots, listing cursors, env-provided registries).
 */
export function parseJsonWith<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
): z.output<Schema> | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
