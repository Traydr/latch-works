import { Result } from 'better-result';

import type { FrameViewResult } from '../../shared/types';

export function getFrameViewValue<T>(result: FrameViewResult<T>, operation: string): T | null {
  if (Result.isError(result)) {
    console.error(`[frameView:${operation}]`, result.error);
    return null;
  }

  return result.value;
}

export function isFrameViewOk<T>(result: FrameViewResult<T>): boolean {
  return Result.isOk(result);
}

export function getFrameViewErrorMessage<T>(
  result: FrameViewResult<T>,
  fallbackMessage: string,
): string | null {
  if (Result.isOk(result)) {
    return null;
  }

  return `${fallbackMessage}: ${result.error.message}`;
}
