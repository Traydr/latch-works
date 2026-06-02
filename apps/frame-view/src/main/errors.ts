import {
  Result,
  type Result as ResultType,
  type SerializedResult,
  TaggedError,
} from 'better-result';
import type { ZodType } from 'zod';
import { serializeIpcResult } from '../shared/ipc';
import type { IpcErrorPayload } from '../shared/types';

export class ValidationError extends TaggedError('ValidationError')<{
  operation: string;
  message: string;
  issues?: string[];
  cause?: unknown;
}>() {}

export class FileSystemError extends TaggedError('FileSystemError')<{
  operation: string;
  message: string;
  path?: string;
  cause?: unknown;
}>() {}

export class DatabaseError extends TaggedError('DatabaseError')<{
  operation: string;
  message: string;
  cause?: unknown;
}>() {}

class MediaToolsError extends TaggedError('MediaToolsError')<{
  operation: string;
  message: string;
  cause?: unknown;
}>() {}

export class WorkerError extends TaggedError('WorkerError')<{
  worker: 'catalog' | 'thumbnail';
  operation: string;
  message: string;
  cause?: unknown;
}>() {}

export class RequestAbortError extends Error {
  constructor(message = 'Request aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

type AppError = ValidationError | FileSystemError | DatabaseError | MediaToolsError | WorkerError;

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
        cause: parsed.error.flatten(),
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
    path: targetPath,
    message,
    cause: error,
  });
}

export function unexpectedDatabaseError(operation: string, error: unknown): DatabaseError {
  const message = error instanceof Error ? error.message : `Unexpected error: ${String(error)}`;
  return new DatabaseError({
    operation,
    message,
    cause: error,
  });
}

function toIpcErrorPayload(error: AppError): IpcErrorPayload {
  if (ValidationError.is(error)) {
    return {
      _tag: 'ValidationError',
      message: error.message,
      operation: error.operation,
      issues: error.issues,
      cause: error.cause,
    };
  }

  if (FileSystemError.is(error)) {
    return {
      _tag: 'FileSystemError',
      message: error.message,
      operation: error.operation,
      path: error.path,
      cause: error.cause,
    };
  }

  if (DatabaseError.is(error)) {
    return {
      _tag: 'DatabaseError',
      message: error.message,
      operation: error.operation,
      cause: error.cause,
    };
  }

  if (MediaToolsError.is(error)) {
    return {
      _tag: 'MediaToolsError',
      message: error.message,
      operation: error.operation,
      cause: error.cause,
    };
  }

  return {
    _tag: 'WorkerError',
    message: error.message,
    worker: error.worker,
    operation: error.operation,
    cause: error.cause,
  };
}

export function serializeAppResult<T>(
  result: ResultType<T, AppError>,
): SerializedResult<T, IpcErrorPayload> {
  if (Result.isError(result)) {
    return serializeIpcResult(Result.err(toIpcErrorPayload(result.error)));
  }

  return serializeIpcResult(Result.ok(result.value));
}
