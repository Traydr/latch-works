import { Result, type Result as ResultType, TaggedError } from "better-result";
import type { ZodType } from "zod";

import { serializeIpcResult } from "../shared/ipc";
import type { IpcErrorPayload } from "../shared/types";

export class ValidationError extends TaggedError("ValidationError")<{
  operation: string;
  message: string;
  issues?: string[];
}>() {}

export class FileSystemError extends TaggedError("FileSystemError")<{
  operation: string;
  message: string;
  path?: string;
}>() {}

export class RunError extends TaggedError("RunError")<{
  operation: string;
  message: string;
}>() {}

type AppError = ValidationError | FileSystemError | RunError;

export function parseWithSchema<T>(
  schema: ZodType<T>,
  payload: unknown,
  operation: string,
): ResultType<T, ValidationError> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return Result.err(
      new ValidationError({
        operation,
        message: `Invalid ${operation} payload`,
        issues: parsed.error.issues.map((issue) => issue.message),
      }),
    );
  }

  return Result.ok(parsed.data);
}

export function unexpectedFileSystemError(
  operation: string,
  error: unknown,
  targetPath?: string,
): FileSystemError {
  const message = error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
  return new FileSystemError({
    operation,
    message,
    path: targetPath,
  });
}

function toIpcError(error: AppError): IpcErrorPayload {
  if (error._tag === "ValidationError") {
    return {
      _tag: "ValidationError",
      message: error.message,
      operation: error.operation,
      issues: error.issues,
    };
  }

  if (error._tag === "FileSystemError") {
    return {
      _tag: "FileSystemError",
      message: error.message,
      operation: error.operation,
      path: error.path,
    };
  }

  return {
    _tag: "RunError",
    message: error.message,
    operation: error.operation,
  };
}

export function serializeAppResult<T>(
  result: ResultType<T, AppError>,
): ReturnType<typeof serializeIpcResult<T>> {
  if (Result.isError(result)) {
    return serializeIpcResult(Result.err(toIpcError(result.error)));
  }

  return serializeIpcResult(Result.ok(result.value));
}
