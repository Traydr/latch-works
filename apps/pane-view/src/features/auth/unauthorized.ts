import { z } from "zod";

/** What an owner-only server function rejects with once the session has gone. */
export const UNAUTHORIZED_MESSAGE = "Unauthorized";

/** Matches that rejection as a server function call surfaces it in the browser. */
export const UnauthorizedErrorSchema = z
  .instanceof(Error)
  .refine((error) => error.message === UNAUTHORIZED_MESSAGE);
