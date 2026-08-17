import { z } from "zod";

/** Any JSON value — what jsonb columns, `JSON.parse`, and request bodies hand back before parsing. */
const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

/** A JSON object — the value type of jsonb columns that hold free-form records. */
export type JsonObject = Record<string, JsonValue>;
