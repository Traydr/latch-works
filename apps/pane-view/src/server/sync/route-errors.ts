import { CleanupJobActiveError } from "../management/guards";
import {
  InvalidSyncPathError,
  SyncRunConflictError,
  SyncRunNotFoundError,
  UploadMismatchError,
} from "./errors";

/**
 * The status each refusal answers with: 400 or 422 for input the server
 * rejects, 404 for an id that names nothing, 409 for a request the library
 * state refuses right now. Anything else a handler throws stays a 500.
 */
const refusalStatuses = [
  [InvalidSyncPathError, 400],
  [SyncRunNotFoundError, 404],
  [SyncRunConflictError, 409],
  [CleanupJobActiveError, 409],
  [UploadMismatchError, 422],
] as const;

/**
 * Wrap a sync route handler so a refusal thrown anywhere beneath it (store,
 * guard, or the handler itself) answers as `{ error }` JSON with its status.
 */
export function withSyncRouteErrors<Context>(
  handler: (context: Context) => Promise<Response>,
): (context: Context) => Promise<Response> {
  return async (context) => {
    try {
      return await handler(context);
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
