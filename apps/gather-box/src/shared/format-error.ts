export function formatError(error: unknown, fallback = "Unknown error"): string {
  if (!error) {
    return fallback;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && "message" in error) {
    const message = error.message;
    return typeof message === "string" ? message : String(message);
  }

  return String(error);
}
