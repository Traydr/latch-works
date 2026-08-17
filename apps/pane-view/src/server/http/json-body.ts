import type { z } from "zod";

export type ParsedJsonBody<Body> = { ok: true; body: Body } | { ok: false; error: string };

/**
 * Read and parse a JSON request body against `schema`. A body that is not
 * JSON parses as an empty object, so a missing body reports the first missing
 * field rather than a syntax error. The error is one line for a 400 response.
 */
export async function readJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<ParsedJsonBody<z.output<Schema>>> {
  const result = schema.safeParse(await request.json().catch(() => ({})));
  return result.success
    ? { ok: true, body: result.data }
    : { ok: false, error: describeFirstIssue(result.error) };
}

/**
 * One-line description of the first issue. Top-level body fields carry
 * messages that name themselves; nested paths (record entries) are prefixed.
 */
export function describeFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid request body";
  }
  return issue.path.length > 1
    ? `${issue.path.map(String).join(".")}: ${issue.message}`
    : issue.message;
}
