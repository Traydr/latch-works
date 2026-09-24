/**
 * A failure the API caller caused or can act on, with the HTTP status the
 * route answers it with: 400 or 422 for input the server rejects, 404 for an
 * id that names nothing, 409 for a request the library state refuses right
 * now. Anything else a handler throws stays a 500.
 */
export class HttpError extends Error {
  readonly status: 400 | 404 | 409 | 422;

  constructor(status: 400 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Wrap a route handler so an `HttpError` thrown anywhere beneath it (store,
 * guard, or the handler itself) answers as `{ error }` JSON with its status.
 */
export function withHttpErrors<Context>(
  handler: (context: Context) => Promise<Response>,
): (context: Context) => Promise<Response> {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }

      throw error;
    }
  };
}
