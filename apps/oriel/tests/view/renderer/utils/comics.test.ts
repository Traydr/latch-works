import { describe, expect, it } from 'vitest';

import { buildComicEntries, sortComicEntries } from '../../../src/renderer/utils/comics';
import type { MediaItem } from '../../../src/shared/types';

function image(path: string, name: string): MediaItem {
  return {
    id: path,
    path,
    name,
    extension: 'jpg',
    mediaType: 'image',
    size: 1,
    mtimeMs: 1,
  };
}

function gif(path: string, name: string): MediaItem {
  return {
    ...image(path, name),
    extension: 'gif',
    mediaType: 'gif',
  };
}

describe('buildComicEntries', () => {
  it('preserves Windows absolute paths while excluding root files', () => {
    const comics = buildComicEntries(
      [
        image('C:\\root\\root-page.jpg', 'root-page.jpg'),
        gif('C:\\root\\my_comic-title\\page-2.gif', 'page-2.gif'),
        image('C:\\root\\my_comic-title\\page-1.jpg', 'page-1.jpg'),
        {
          ...image('C:\\root\\my_comic-title\\clip.mp4', 'clip.mp4'),
          extension: 'mp4',
          mediaType: 'video',
        },
      ],
      'C:\\root',
    );

    expect(comics).toHaveLength(1);
    expect(comics[0]).toMatchObject({
      cover: { id: 'C:\\root\\my_comic-title\\page-1.jpg' },
      folderPath: 'C:\\root\\my_comic-title',
      name: 'my comic title',
    });
    expect(comics[0]?.pages.map((page) => page.name)).toEqual(['page-1.jpg', 'page-2.gif']);
  });

  it('preserves POSIX absolute paths while excluding root files', () => {
    const comics = buildComicEntries(
      [
        image('/Users/gallery/root-page.jpg', 'root-page.jpg'),
        image('/Users/gallery/comic/page-10.jpg', 'page-10.jpg'),
        image('/Users/gallery/comic/page-2.jpg', 'page-2.jpg'),
      ],
      '/Users/gallery',
    );

    expect(comics[0]).toMatchObject({
      folderPath: '/Users/gallery/comic',
      name: 'comic',
    });
    expect(comics[0]?.pages.map((page) => page.name)).toEqual(['page-2.jpg', 'page-10.jpg']);
  });

  it('sorts comic entries by their first A-Z page item', () => {
    const comics = buildComicEntries([
      image('C:\\root\\z-comic\\a-page.jpg', 'a-page.jpg'),
      image('C:\\root\\a-comic\\z-page.jpg', 'z-page.jpg'),
    ]);

    expect(comics.map((comic) => comic.name)).toEqual(['a comic', 'z comic']);
    expect(sortComicEntries(comics, 'name-asc', 1).map((comic) => comic.name)).toEqual([
      'z comic',
      'a comic',
    ]);
    expect(sortComicEntries(comics, 'name-desc', 1).map((comic) => comic.name)).toEqual([
      'a comic',
      'z comic',
    ]);
  });
});
