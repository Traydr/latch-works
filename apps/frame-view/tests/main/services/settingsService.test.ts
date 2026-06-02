import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsService } from '../../../src/main/services/settingsService';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

describe('SettingsService', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), 'frame-view-settings-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('coalesces multiple fast updates into a single write', async () => {
    const service = new SettingsService(userDataPath);
    await service.init();

    const writeSpy = vi.spyOn(fs, 'writeFile');
    vi.useFakeTimers();

    const firstUpdate = service.updateSettings({ theme: 'dark' });
    const secondUpdate = service.updateSettings({ loopVideos: false });

    await vi.advanceTimersByTimeAsync(149);
    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([firstUpdate, secondUpdate]);

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('flushNowSync writes the latest state immediately', async () => {
    const service = new SettingsService(userDataPath);
    await service.init();

    vi.useFakeTimers();
    const pendingUpdate = service.updateSettings({ theme: 'dark', loopVideos: false });

    await service.flushNowSync();
    await pendingUpdate;

    const raw = await readFile(path.join(userDataPath, 'frame-view-settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { settings: { theme: string; loopVideos: boolean } };

    expect(parsed.settings.theme).toBe('dark');
    expect(parsed.settings.loopVideos).toBe(false);
  });

  it('persists debug settings and applies defaults for older settings payloads', async () => {
    const settingsFilePath = path.join(userDataPath, 'frame-view-settings.json');
    await fs.writeFile(
      settingsFilePath,
      JSON.stringify({
        settings: {
          theme: 'system',
          filters: {
            imageExtensions: ['png'],
            videoExtensions: ['mp4'],
            showImages: true,
            showVideos: true,
          },
        },
        windowBounds: null,
        windowMaximized: false,
      }),
      'utf8',
    );

    const service = new SettingsService(userDataPath);
    await service.init();

    expect(service.getSettings().debug).toEqual({
      enableDebugLogging: false,
      enablePerformanceMonitoring: false,
    });

    await service.updateSettings({
      debug: {
        enableDebugLogging: true,
        enablePerformanceMonitoring: true,
      },
    });

    const raw = await readFile(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      settings: { debug: { enableDebugLogging: boolean; enablePerformanceMonitoring: boolean } };
    };

    expect(parsed.settings.debug).toEqual({
      enableDebugLogging: true,
      enablePerformanceMonitoring: true,
    });
  });

  it('persists per-root gallery preferences independently', async () => {
    const settingsFilePath = path.join(userDataPath, 'frame-view-settings.json');
    const service = new SettingsService(userDataPath);
    await service.init();

    await service.updateSettings({
      rootGalleryPreferences: {
        ...DEFAULT_SETTINGS.rootGalleryPreferences,
        'C:\\library': {
          comicMode: true,
          excludedRootChildPaths: ['C:\\library\\skip'],
        },
        'C:\\other': {
          comicMode: false,
          excludedRootChildPaths: [],
        },
      },
    });
    await service.flushNowSync();

    const raw = await readFile(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      settings: {
        rootGalleryPreferences: Record<
          string,
          { comicMode: boolean; excludedRootChildPaths: string[] }
        >;
      };
    };

    expect(parsed.settings.rootGalleryPreferences['C:\\library']).toEqual({
      comicMode: true,
      excludedRootChildPaths: ['C:\\library\\skip'],
    });
    expect(parsed.settings.rootGalleryPreferences['C:\\other']).toEqual({
      comicMode: false,
      excludedRootChildPaths: [],
    });
  });
});
