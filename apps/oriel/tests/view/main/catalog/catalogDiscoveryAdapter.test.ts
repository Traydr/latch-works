import { describe, expect, it } from 'vitest';

import {
  classifyFrameCandidate,
  type FrameScanFilters,
  shouldSkipDirectoryName,
  toFrameMediaItem,
} from '../../../src/main/catalog/catalogDiscoveryAdapter';

const filters: FrameScanFilters = {
  imageExtensions: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']),
  showImages: true,
  showVideos: true,
  videoExtensions: new Set(['mp4', 'webm', 'mov']),
};

describe('catalogDiscoveryAdapter', () => {
  it('skips system junk directories shared with media-index', () => {
    expect(shouldSkipDirectoryName('__MACOSX')).toBe(true);
    expect(shouldSkipDirectoryName('photos')).toBe(false);
  });

  it('classifies media with Frame filter overlays and skips junk files', () => {
    expect(classifyFrameCandidate('cover.JPG', filters)).toEqual({
      extension: 'jpg',
      mediaType: 'image',
      name: 'cover.JPG',
    });
    expect(classifyFrameCandidate('clip.mp4', filters)).toEqual({
      extension: 'mp4',
      mediaType: 'video',
      name: 'clip.mp4',
    });
    expect(classifyFrameCandidate('.DS_Store', filters)).toBeNull();
    expect(classifyFrameCandidate('notes.txt', filters)).toBeNull();
  });

  it('honors showImages/showVideos toggles', () => {
    expect(
      classifyFrameCandidate('cover.jpg', {
        ...filters,
        showImages: false,
      }),
    ).toBeNull();
    expect(
      classifyFrameCandidate('clip.mp4', {
        ...filters,
        showVideos: false,
      }),
    ).toBeNull();
  });

  it('builds Frame absolute-path MediaItems without thumbnailPath', () => {
    const item = toFrameMediaItem(
      {
        extension: 'jpg',
        fullPath: '/archive/photos/cover.jpg',
        mediaType: 'image',
        name: 'cover.jpg',
      },
      { mtimeMs: 1000, size: 42 },
    );

    expect(item).toEqual({
      id: '/archive/photos/cover.jpg:42:1000',
      path: '/archive/photos/cover.jpg',
      name: 'cover.jpg',
      extension: 'jpg',
      mediaType: 'image',
      size: 42,
      mtimeMs: 1000,
    });
    expect(item.thumbnailPath).toBeUndefined();
  });
});
