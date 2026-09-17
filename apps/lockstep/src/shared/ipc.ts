import { Result, type Result as ResultType, type SerializedResult } from "better-result";
import type { z } from "zod";

import { createSerializedResultSchema, type JsonValue } from "./contracts";
import type { IpcErrorPayload } from "./types";

function protocolError(channel: string): IpcErrorPayload {
  return {
    _tag: "ProtocolError",
    channel,
    message: `Invalid IPC result payload for ${channel}`,
  };
}

export function serializeIpcResult<T>(
  result: ResultType<T, IpcErrorPayload>,
): SerializedResult<T, IpcErrorPayload> {
  if (Result.isError(result)) {
    return { status: "error", error: result.error };
  }

  return { status: "ok", value: result.value };
}

export function deserializeIpcResult<T>(
  value: JsonValue,
  schema: z.ZodType<T>,
  channel: string,
): ResultType<T, IpcErrorPayload> {
  const parsed = createSerializedResultSchema(schema).safeParse(value);
  if (!parsed.success) {
    return Result.err(protocolError(channel));
  }

  if (parsed.data.status === "error") {
    return Result.err(parsed.data.error);
  }

  return Result.ok(parsed.data.value);
}
