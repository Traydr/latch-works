import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';

import { createMainWindowCloseHandler } from '../../src/main/windowLifecycle';
import { waitForCondition } from '../testUtils';

describe('mainWindowLifecycle', () => {
  it('persists window state and destroys the window once on close', async () => {
    const destroy = vi.fn();
    const mainWindow = {
      destroy,
      getBounds: vi.fn(() => ({ x: 10, y: 10, width: 1200, height: 800 })),
      getNormalBounds: vi.fn(() => ({ x: 10, y: 10, width: 1200, height: 800 })),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
    };
    const settingsService = {
      flushNowSync: vi.fn(async () => Result.ok(undefined)),
      updateWindowBounds: vi.fn(async () => Result.ok(undefined)),
      updateWindowMaximized: vi.fn(async () => Result.ok(undefined)),
    };
    const logErrorMessage = vi.fn();
    const preventDefault = vi.fn();
    const handler = createMainWindowCloseHandler(
      mainWindow as never,
      settingsService as never,
      logErrorMessage,
    );

    handler({ preventDefault } as never);
    handler({ preventDefault } as never);
    await waitForCondition(() => destroy.mock.calls.length === 1);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(settingsService.updateWindowMaximized).toHaveBeenCalledTimes(1);
    expect(settingsService.updateWindowBounds).toHaveBeenCalledTimes(1);
    expect(settingsService.flushNowSync).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(logErrorMessage).not.toHaveBeenCalled();
  });
});
