import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SettingsService } from '../../../src/main/services/settingsService';
import { AppSettingsSchema } from '../../../src/shared/contracts';
import { type AppSettings, DEFAULT_SETTINGS } from '../../../src/shared/types';

/** The settings file on disk wraps the settings the service persists. */
const PersistedStateSchema = z.object({ settings: AppSettingsSchema });

async function readPersistedSettings(filePath: string): Promise<AppSettings> {
  const raw = await readFile(filePath, 'utf8');
  return PersistedStateSchema.parse(JSON.parse(raw)).settings;
}

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

    const settings = await readPersistedSettings(
      path.join(userDataPath, 'frame-view-settings.json'),
    );

    expect(settings.theme).toBe('dark');
    expect(settings.loopVideos).toBe(false);
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

    const settings = await readPersistedSettings(settingsFilePath);

    expect(settings.debug).toEqual({
      enableDebugLogging: true,
      enablePerformanceMonitoring: true,
    });
  });

  it('adds AVIF support when loading version 2 settings', async () => {
    const settingsFilePath = path.join(userDataPath, 'frame-view-settings.json');
    await fs.writeFile(
      settingsFilePath,
      JSON.stringify({
        version: 2,
        settings: {
          ...DEFAULT_SETTINGS,
          filters: {
            ...DEFAULT_SETTINGS.filters,
            imageExtensions: DEFAULT_SETTINGS.filters.imageExtensions.filter(
              (extension) => extension !== 'avif',
            ),
          },
        },
        windowBounds: null,
        windowMaximized: false,
      }),
      'utf8',
    );

    const service = new SettingsService(userDataPath);
    await service.init();

    expect(service.getSettings().filters.imageExtensions).toContain('avif');
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

    const settings = await readPersistedSettings(settingsFilePath);

    expect(settings.rootGalleryPreferences['C:\\library']).toEqual({
      comicMode: true,
      excludedRootChildPaths: ['C:\\library\\skip'],
    });
    expect(settings.rootGalleryPreferences['C:\\other']).toEqual({
      comicMode: false,
      excludedRootChildPaths: [],
    });
  });
});
