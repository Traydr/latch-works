import path from 'node:path';

import { Result, type Result as ResultType } from 'better-result';
import type { Rectangle } from 'electron';
import { AppSettingsPatchSchema } from '../../shared/contracts';
import type { AppSettings, AppSettingsPatch } from '../../shared/types';
import { type FileSystemError, toError, unexpectedFileSystemError } from '../errors';
import {
  createDefaultPersistedState,
  normalizeAppSettings,
  type PersistedState,
  readPersistedState,
  writePersistedState,
} from './settingsPersistence';

interface FlushOptions {
  immediate?: boolean;
}

const FLUSH_DEBOUNCE_MS = 150;

export class SettingsService {
  private readonly filePath: string;

  private state: PersistedState = createDefaultPersistedState();
  private flushQueue: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private pendingFlushPromise: Promise<void> | null = null;
  private pendingFlushResolve: (() => void) | null = null;
  private pendingFlushReject: ((error: Error) => void) | null = null;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'frame-view-settings.json');
  }

  async init(): Promise<ResultType<void, FileSystemError>> {
    try {
      this.state = await readPersistedState(this.filePath);
      return Result.ok();
    } catch {
      this.state = createDefaultPersistedState();
      return this.flushNowSync();
    }
  }

  getSettings(): AppSettings {
    return this.state.settings;
  }

  async updateSettings(
    patch: AppSettingsPatch,
    options?: FlushOptions,
  ): Promise<ResultType<AppSettings, FileSystemError>> {
    const parsedPatch = AppSettingsPatchSchema.parse(patch);
    const merged = {
      ...this.state.settings,
      ...parsedPatch,
      debug: {
        ...this.state.settings.debug,
        ...parsedPatch.debug,
      },
      filters: {
        ...this.state.settings.filters,
        ...parsedPatch.filters,
      },
    };

    this.state.settings = normalizeAppSettings(merged);

    try {
      await this.persist(options);
      return Result.ok(this.state.settings);
    } catch (cause) {
      return Result.err(
        unexpectedFileSystemError('update-settings', toError(cause), this.filePath),
      );
    }
  }

  getWindowBounds(): Rectangle | null {
    return this.state.windowBounds;
  }

  async updateWindowBounds(
    bounds: Rectangle,
    options?: FlushOptions,
  ): Promise<ResultType<void, FileSystemError>> {
    this.state.windowBounds = bounds;
    try {
      await this.persist(options);
      return Result.ok();
    } catch (cause) {
      return Result.err(
        unexpectedFileSystemError('update-window-bounds', toError(cause), this.filePath),
      );
    }
  }

  getWindowMaximized(): boolean {
    return this.state.windowMaximized;
  }

  async updateWindowMaximized(
    isMaximized: boolean,
    options?: FlushOptions,
  ): Promise<ResultType<void, FileSystemError>> {
    this.state.windowMaximized = isMaximized;
    try {
      await this.persist(options);
      return Result.ok();
    } catch (cause) {
      return Result.err(
        unexpectedFileSystemError('update-window-maximized', toError(cause), this.filePath),
      );
    }
  }

  async flushNowSync(): Promise<ResultType<void, FileSystemError>> {
    try {
      const promise = this.markDirty();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      await this.commitPendingFlush();
      await promise;
      return Result.ok();
    } catch (cause) {
      return Result.err(unexpectedFileSystemError('flush-settings', toError(cause), this.filePath));
    }
  }

  private async persist(options?: FlushOptions): Promise<void> {
    if (options?.immediate) {
      await this.flushNowSync();
      return;
    }

    await this.scheduleFlush();
  }

  private scheduleFlush(): Promise<void> {
    const promise = this.markDirty();

    if (this.flushTimer) {
      return promise;
    }

    this.flushTimer = setTimeout(() => {
      void this.commitPendingFlush();
    }, FLUSH_DEBOUNCE_MS);

    return promise;
  }

  private markDirty(): Promise<void> {
    this.dirty = true;

    if (this.pendingFlushPromise) {
      return this.pendingFlushPromise;
    }

    this.pendingFlushPromise = new Promise<void>((resolve, reject) => {
      this.pendingFlushResolve = resolve;
      this.pendingFlushReject = reject;
    });

    return this.pendingFlushPromise;
  }

  private async commitPendingFlush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const resolve = this.pendingFlushResolve;
    const reject = this.pendingFlushReject;

    if (!this.pendingFlushPromise || !resolve || !reject) {
      return;
    }

    this.pendingFlushPromise = null;
    this.pendingFlushResolve = null;
    this.pendingFlushReject = null;

    const flushTask = async (): Promise<void> => {
      if (!this.dirty) {
        return;
      }

      this.dirty = false;
      await writePersistedState(this.filePath, this.state);
    };

    this.flushQueue = this.flushQueue.then(flushTask, flushTask);

    try {
      await this.flushQueue;
      resolve();
    } catch (cause) {
      reject(toError(cause));
    }

    if (this.dirty && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.commitPendingFlush();
      }, FLUSH_DEBOUNCE_MS);
    }
  }
}
