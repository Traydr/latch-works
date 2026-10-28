/**
 * A seeded random source. Every choice the fixture makes comes from one of these, keyed by what it
 * describes (`still:1234`, `video:hevc:7`), so a file's look and size never depend on which other
 * files a run happens to make: the smoke fixture's files equal the full fixture's at the same index.
 */
export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
}

/** FNV-1a over the key's UTF-16 units: a stable 32-bit seed for a string. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}

/** Mulberry32: small, fast and good enough for picking sizes and colours. */
export function seededRandom(seed: string, key: string): Random {
  let state = hashKey(`${seed}:${key}`);

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick: <T>(values: readonly T[]): T => {
      const value = values[int(0, values.length - 1)];

      if (value === undefined) {
        throw new Error("Cannot pick from an empty list");
      }

      return value;
    },
    chance: (probability) => next() < probability,
  };
}
