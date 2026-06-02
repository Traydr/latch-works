import type { GallerySortMode, MediaItem } from "./media.js";

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareByName(
  a: Pick<MediaItem, "name" | "path">,
  b: Pick<MediaItem, "name" | "path">,
) {
  const byName = nameCollator.compare(a.name, b.name);
  if (byName !== 0) {
    return byName;
  }

  return nameCollator.compare(a.path, b.path);
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function createRandomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
}

export function sortMediaItems(
  items: readonly MediaItem[],
  sortMode: GallerySortMode,
  randomSeed: number,
): MediaItem[] {
  const sorted = [...items];

  sorted.sort((a, b) => {
    switch (sortMode) {
      case "name-asc":
        return compareByName(a, b);
      case "name-desc":
        return compareByName(b, a);
      case "date-newest": {
        const byDate = b.mtimeMs - a.mtimeMs;
        return byDate !== 0 ? byDate : compareByName(a, b);
      }
      case "date-oldest": {
        const byDate = a.mtimeMs - b.mtimeMs;
        return byDate !== 0 ? byDate : compareByName(a, b);
      }
      case "random": {
        const aScore = hashString(`${randomSeed}:${a.path}`);
        const bScore = hashString(`${randomSeed}:${b.path}`);
        return aScore !== bScore ? aScore - bScore : compareByName(a, b);
      }
      default:
        return compareByName(a, b);
    }
  });

  return sorted;
}
