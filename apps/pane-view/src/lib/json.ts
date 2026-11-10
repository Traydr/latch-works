import { z } from "zod";

/** Any JSON value — what jsonb columns, `JSON.parse`, and request bodies hand back before parsing. */
const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;
