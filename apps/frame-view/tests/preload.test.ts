import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createFrameViewApi, type PreloadIpcTransport } from '../src/preload/frameViewApi';
import type { JsonValue } from '../src/shared/contracts';
import { serializeIpcResult } from '../src/shared/ipc';
import { DEFAULT_SETTINGS } from '../src/shared/types';

function createTransport() {
  const listeners = new Map<string, (payload: JsonValue) => void>();
  const unsubscribedChannels: string[] = [];
  const invoke = vi.fn<PreloadIpcTransport['invoke']>(async () => null);

  const transport: PreloadIpcTransport = {
    invoke,
    subscribe: (channel, listener) => {
      listeners.set(channel, listener);
      return () => {
        unsubscribedChannels.push(channel);
        listeners.delete(channel);
      };
    },
  };

  return { invoke, listeners, transport, unsubscribedChannels };
}

describe('frame view preload bridge', () => {
  it('deserializes invoke results through the exposed API', async () => {
    const { invoke, transport } = createTransport();
    // The real transport hands back whatever survived IPC serialization.
    invoke.mockResolvedValue(z.json().parse(serializeIpcResult(Result.ok(DEFAULT_SETTINGS))));

    const result = await createFrameViewApi(transport).getSettings();

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) ? result.value : null).toEqual(DEFAULT_SETTINGS);
    expect(invoke).toHaveBeenCalledWith('settings:get');
  });

  it('parses app commands and unsubscribes the channel listener', () => {
    const { listeners, transport, unsubscribedChannels } = createTransport();
    const listener = vi.fn();

    const unsubscribe = createFrameViewApi(transport).onAppCommand(listener);
    const deliver = listeners.get('app:command');

    deliver?.({ type: 'toggle-settings' });
    deliver?.({ type: 'unknown-command' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'toggle-settings' });

    unsubscribe();

    expect(unsubscribedChannels).toEqual(['app:command']);
  });

  it('parses scan events and ignores invalid payloads', () => {
    const { listeners, transport } = createTransport();
    const listener = vi.fn();

    createFrameViewApi(transport).onScanEvent(listener);
    const deliver = listeners.get('scan:event');

    deliver?.({ type: 'reset', runId: 1, rootPath: 'C:\\media', recursive: false });
    deliver?.({ type: 'reset', rootPath: 'C:\\media' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      type: 'reset',
      runId: 1,
      rootPath: 'C:\\media',
      recursive: false,
    });
  });
});
