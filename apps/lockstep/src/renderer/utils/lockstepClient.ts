import { Result } from "better-result";

import type { IpcErrorPayload } from "../../shared/types";

type LockstepResult<T> =
  | ReturnType<typeof Result.ok<T>>
  | ReturnType<typeof Result.err<IpcErrorPayload>>;

export function getLockstepValue<T>(result: LockstepResult<T>): T {
  if (!Result.isOk(result)) {
    const error = result.error as IpcErrorPayload;
    throw new Error(error.message);
  }

  return result.value;
}

export function getLockstepErrorMessage(error: IpcErrorPayload): string {
  return error.message;
}
