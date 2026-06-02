import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';

import { getFrameViewErrorMessage } from '../../../src/renderer/utils/frameViewResult';

describe('frameViewResult helpers', () => {
  it('preserves structured IPC error messages for renderer status text', () => {
    const message = getFrameViewErrorMessage(
      Result.err({
        _tag: 'ValidationError',
        message: 'Invalid settings payload',
        operation: 'settings:update',
      }),
      'Settings update failed',
    );

    expect(message).toBe('Settings update failed: Invalid settings payload');
  });
});
