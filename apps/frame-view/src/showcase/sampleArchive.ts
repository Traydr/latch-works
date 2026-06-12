import type { MediaItem } from '../shared/types';

const SAMPLE_FOLDER = '/tmp/showcase-archive/sfw/photos';

const SAMPLE_FILES = Array.from({ length: 18 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return `sample-${number}.jpg`;
});

export const SHOWCASE_FOLDER_PATH = SAMPLE_FOLDER;

export function buildShowcaseMediaItems(): MediaItem[] {
  const now = Date.now();

  return SAMPLE_FILES.map((fileName, index) => {
    const filePath = `${SAMPLE_FOLDER}/${fileName}`;

    return {
      id: `showcase-${index + 1}`,
      path: filePath,
      name: fileName,
      extension: 'jpg',
      mediaType: 'image',
      size: 240_000 + index * 12_000,
      mtimeMs: now - index * 86_400_000,
      width: 1600,
      height: 1200,
    };
  });
}
