import { Result, type Result as ResultType, type SerializedResult } from 'better-result';
import type { z } from 'zod';

import { createSerializedResultSchema, IpcErrorPayloadSchema } from './contracts';
import type { IpcErrorPayload } from './types';

function protocolError(channel: string, payload: unknown): IpcErrorPayload {
  return {
    _tag: 'ProtocolError',
    message: `Invalid IPC result payload for ${channel}`,
    channel,
    payload,
  };
}

export function serializeIpcResult<T>(
  result: ResultType<T, IpcErrorPayload>,
): SerializedResult<T, IpcErrorPayload> {
  return Result.serialize(result);
}

export function deserializeIpcResult<T>(
  value: unknown,
  schema: z.ZodType<T>,
  channel: string,
): ResultType<T, IpcErrorPayload> {
  const parsed = createSerializedResultSchema(schema).safeParse(value);
  if (!parsed.success) {
    return Result.err(protocolError(channel, value));
  }

  const result = Result.deserialize<T, IpcErrorPayload>(parsed.data);
  if (Result.isError(result)) {
    const errorParse = IpcErrorPayloadSchema.safeParse(result.error);
    if (!errorParse.success) {
      return Result.err(protocolError(channel, value));
    }

    return Result.err(errorParse.data);
  }

  return Result.ok(result.value);
}
