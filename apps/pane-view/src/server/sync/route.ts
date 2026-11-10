import type { JsonValue } from "@/lib/json";
import { requireSyncApiToken } from "../auth/api-token";
import { CleanupJobActiveError } from "../db/library-guards";
import { SyncRunConflictError, SyncRunNotFoundError, UploadMismatchError } from "./errors";
import type { ParsedSyncBody } from "./validation";

/**
 * The status each refusal answers with: 404 for an id that names nothing, 409
 * for a request the library state refuses right now, 422 for an upload storage
 * does not attest. Anything else a handler throws stays a 500.
 */
const refusalStatuses = [
  [SyncRunNotFoundError, 404],
  [SyncRunConflictError, 409],
  [CleanupJobActiveError, 409],
  [UploadMismatchError, 422],
] as const;

type SyncRouteHandler<Params> = (context: {
  params: Params;
  request: Request;
}) => Promise<Response>;

interface SyncRouteOptions<Body, Params, Answer> {
  handle(body: Body, params: Params): Promise<Answer>;
  parse(json: JsonValue): ParsedSyncBody<Body>;
}

/**
 * A sync API handler: the bearer token, then the body, refused with 400 and the parser's error.
 * The handler's answer goes back as JSON (`{}` when it has none), and a refusal thrown anywhere
 * beneath it as `{ error }` with its status.
 */
export function syncRoute<Body, Params, Answer>(
  options: SyncRouteOptions<Body, Params, Answer>,
): SyncRouteHandler<Params> {
  return async ({ params, request }) => {
    try {
      const unauthorized = requireSyncApiToken(request);

      if (unauthorized) {
        return unauthorized;
      }

      // A body that is not JSON reads as an empty object, so a missing body
      // reports the first missing field rather than a syntax error.
      const json: JsonValue = await request.json().catch(() => ({}));
      const parsed = options.parse(json);

      if (!parsed.ok) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }

      return Response.json((await options.handle(parsed.body, params)) ?? {});
    } catch (error) {
      for (const [RefusalError, status] of refusalStatuses) {
        if (error instanceof RefusalError) {
          return Response.json({ error: error.message }, { status });
        }
      }

      throw error;
    }
  };
}
