// @vitest-environment jsdom

import { Result } from 'better-result';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serializeIpcResult } from '../src/shared/ipc';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld,
  },
  ipcRenderer: {
    invoke,
    on,
    removeListener,
  },
}));

describe('preload', () => {
  beforeEach(() => {
    exposeInMainWorld.mockReset();
    invoke.mockReset();
    on.mockReset();
    removeListener.mockReset();
    vi.resetModules();
  });

  it('deserializes invoke results through the exposed API', async () => {
    invoke.mockResolvedValue(serializeIpcResult(Result.ok(DEFAULT_SETTINGS)));

    await import('../src/preload');

    const api = exposeInMainWorld.mock.calls[0]?.[1] as Window['frameView'];
    const result = await api.getSettings();

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) ? result.value : null).toEqual(DEFAULT_SETTINGS);
    expect(invoke).toHaveBeenCalledWith('settings:get');
  });

  it('parses app commands and removes listeners on unsubscribe', async () => {
    await import('../src/preload');

    const api = exposeInMainWorld.mock.calls[0]?.[1] as Window['frameView'];
    const listener = vi.fn();
    const unsubscribe = api.onAppCommand(listener);
    const wrappedListener = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    wrappedListener({}, { type: 'toggle-settings' });
    wrappedListener({}, { type: 'unknown-command' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'toggle-settings' });

    unsubscribe();

    expect(removeListener).toHaveBeenCalledWith('app:command', wrappedListener);
  });

  it('parses scan events and ignores invalid payloads', async () => {
    await import('../src/preload');

    const api = exposeInMainWorld.mock.calls[0]?.[1] as Window['frameView'];
    const listener = vi.fn();
    api.onScanEvent(listener);
    const wrappedListener = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    wrappedListener({}, { type: 'reset', runId: 1, rootPath: 'C:\\media', recursive: false });
    wrappedListener({}, { type: 'reset', rootPath: 'C:\\media' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: 'reset',
      runId: 1,
      rootPath: 'C:\\media',
      recursive: false,
    });
  });
});
