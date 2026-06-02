import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  AppSettingsSchema,
  createSerializedResultSchema,
  PathInputSchema,
  ScanOptionsSchema,
} from '../../src/shared/contracts';
import { deserializeIpcResult, serializeIpcResult } from '../../src/shared/ipc';

describe('shared contracts', () => {
  it('normalizes and validates scan options with shared schemas', () => {
    const parsed = ScanOptionsSchema.safeParse({
      rootPath: '  C:\\gallery  ',
      recursive: true,
      excludedRootChildPaths: ['  C:\\gallery\\skip  '],
      filters: {
        imageExtensions: ['.JPG', 'png', 'jpg'],
        videoExtensions: ['mp4'],
        showImages: true,
        showVideos: false,
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.rootPath).toBe('C:\\gallery');
    expect(parsed.data.excludedRootChildPaths).toEqual(['C:\\gallery\\skip']);
    expect(parsed.data.filters.imageExtensions).toEqual(['jpg', 'png']);
  });

  it('deserializes valid IPC results and rejects malformed payloads', () => {
    const validPayload = serializeIpcResult(
      Result.ok({
        theme: 'dark',
        rememberLastFolder: true,
        recursiveDefault: false,
        autoplayOnHover: true,
        autoplayVideos: true,
        loopViewerNavigation: true,
        previewAudioEnabled: false,
        loopVideos: true,
        thumbnailSize: 220,
        sortMode: 'name-asc',
        randomSeed: 1,
        filters: {
          imageExtensions: ['jpg'],
          videoExtensions: ['mp4'],
          showImages: true,
          showVideos: true,
        },
        rootGalleryPreferences: {},
        lastFolderPath: null,
        debug: {
          enableDebugLogging: false,
          enablePerformanceMonitoring: false,
        },
      }),
    );

    const validResult = deserializeIpcResult(validPayload, AppSettingsSchema, 'settings:get');
    expect(Result.isOk(validResult)).toBe(true);

    const invalidResult = deserializeIpcResult(
      { status: 'ok', value: { theme: 'wat' } },
      AppSettingsSchema,
      'settings:get',
    );
    expect(Result.isError(invalidResult)).toBe(true);
    if (Result.isError(invalidResult)) {
      expect(invalidResult.error._tag).toBe('ProtocolError');
    }
  });

  it('builds a serialized result schema for simple values', () => {
    const schema = createSerializedResultSchema(PathInputSchema.nullable());
    expect(schema.parse({ status: 'ok', value: 'C:\\gallery' })).toEqual({
      status: 'ok',
      value: 'C:\\gallery',
    });
    expect(() => schema.parse({ status: 'error', error: { nope: true } })).toThrow();
  });
});
