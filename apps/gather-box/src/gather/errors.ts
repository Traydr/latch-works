export function formatError(error: unknown): string {
  if (!error) {
    return "Unknown error";
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
