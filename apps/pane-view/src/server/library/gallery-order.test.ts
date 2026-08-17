import { describe, expect, it } from "vitest";
import { createGalleryRandomSeed } from "@/features/gallery/gallery-random-seed";
import {
  GALLERY_RANDOM_SEED_PATTERN,
  type GalleryRandomSeed,
  GalleryRandomSeedSchema,
  type GallerySubjectKind,
  galleryRandomOrderKey,
} from "./gallery-order";

/**
 * Sixteen fixed seeds. The statistical bounds below are deterministic for
 * this list; if a future edit to the list trips one, change the seeds, not
 * the bound. Each bound documents what a broken key would score.
 */
const SEEDS = [
  "00000000000000000000000000000000",
  "ffffffffffffffffffffffffffffffff",
  "0123456789abcdef0123456789abcdef",
  "fedcba9876543210fedcba9876543210",
  "1a2b3c4d5e6f70819a2b3c4d5e6f7081",
  "9f8e7d6c5b4a39281f0e9d8c7b6a5948",
  "5eed5eed5eed5eed5eed5eed5eed5eed",
  "c0ffeec0ffeec0ffeec0ffeec0ffeec0",
  "deadbeefdeadbeefdeadbeefdeadbeef",
  "0000000000000000ffffffffffffffff",
  "ffffffffffffffff0000000000000000",
  "123456789abcdef0123456789abcdef0",
  "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5",
  "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
  "77777777777777777777777777777777",
  "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
] as const satisfies readonly GalleryRandomSeed[];

const PAGE_SIZE = 48;
const SUBJECT_COUNT = 1000;
const COMMON_PREFIX_COUNT = 200;
const COMMON_PREFIX = "folder-a/";

interface Subject {
  id: string;
  kind: GallerySubjectKind;
}

/** 1,000 subjects: 200 comic paths under one folder, 300 other comic paths, 500 media UUIDs. */
function buildSubjects(): Subject[] {
  const subjects: Subject[] = [];
  for (let index = 0; index < COMMON_PREFIX_COUNT; index += 1) {
    subjects.push({
      id: `${COMMON_PREFIX}chapter-${String(index).padStart(3, "0")}`,
      kind: "comic",
    });
  }
  for (let index = 0; index < 300; index += 1) {
    subjects.push({ id: `series-${index % 17}/volume-${index}`, kind: "comic" });
  }
  for (let index = 0; index < SUBJECT_COUNT - COMMON_PREFIX_COUNT - 300; index += 1) {
    const hex = index.toString(16).padStart(12, "0");
    subjects.push({ id: `00000000-0000-4000-8000-${hex}`, kind: "media" });
  }
  return subjects;
}

const SUBJECTS = buildSubjects();

function permutation(seed: GalleryRandomSeed, subjects: readonly Subject[]): Subject[] {
  return [...subjects]
    .map((subject) => ({ key: galleryRandomOrderKey(seed, subject.kind, subject.id), subject }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map(({ subject }) => subject);
}

function quartile(position: number): number {
  return Math.floor((position * 4) / SUBJECT_COUNT);
}

function positions(order: readonly Subject[]): Map<string, number> {
  return new Map(order.map((subject, index) => [`${subject.kind}:${subject.id}`, index]));
}

function shuffleDeterministically<T>(items: readonly T[]): T[] {
  // A fixed LCG so "input order does not matter" is tested against a real reordering.
  const copy = [...items];
  let state = 2463534242;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const swapped = copy[swap];
    const current = copy[index];
    if (swapped !== undefined && current !== undefined) {
      copy[index] = swapped;
      copy[swap] = current;
    }
  }
  return copy;
}

describe("galleryRandomOrderKey", () => {
  it("is 32 lowercase hex characters", () => {
    const key = galleryRandomOrderKey(SEEDS[2], "media", "x");
    expect(key).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("is deterministic for the same seed and subject set", () => {
    for (const seed of SEEDS) {
      expect(permutation(seed, SUBJECTS)).toEqual(permutation(seed, SUBJECTS));
    }
  });

  it("does not depend on input order", () => {
    const shuffled = shuffleDeterministically(SUBJECTS);
    expect(shuffled).not.toEqual(SUBJECTS);
    for (const seed of SEEDS) {
      expect(permutation(seed, shuffled)).toEqual(permutation(seed, SUBJECTS));
    }
  });

  it("contains every subject exactly once", () => {
    for (const seed of SEEDS) {
      const order = permutation(seed, SUBJECTS);
      expect(order).toHaveLength(SUBJECT_COUNT);
      expect(new Set(order.map((subject) => `${subject.kind}:${subject.id}`)).size).toBe(
        SUBJECT_COUNT,
      );
    }
  });

  it("gives every seed a distinct permutation and a distinct first page", () => {
    const firstPages = new Set<string>();
    const orders = new Set<string>();
    for (const seed of SEEDS) {
      const order = permutation(seed, SUBJECTS).map((subject) => subject.id);
      orders.add(order.join("\n"));
      firstPages.add(order.slice(0, PAGE_SIZE).join("\n"));
    }
    expect(orders.size).toBe(SEEDS.length);
    expect(firstPages.size).toBe(SEEDS.length);
  });

  it("moves subjects between quartiles when the seed changes", () => {
    // Independent keys keep ~25% of subjects in the same quartile. A key that
    // ignores the seed, or a constant, scores 1.0. Bound: 0.35.
    for (const [index, seed] of SEEDS.entries()) {
      const nextSeed = SEEDS[index + 1];
      if (nextSeed === undefined) break;
      const before = positions(permutation(seed, SUBJECTS));
      const after = positions(permutation(nextSeed, SUBJECTS));
      let same = 0;
      for (const [key, position] of before) {
        const afterPosition = after.get(key);
        if (afterPosition !== undefined && quartile(position) === quartile(afterPosition)) {
          same += 1;
        }
      }
      expect(same / SUBJECT_COUNT).toBeLessThanOrEqual(0.35);
    }
  });

  it("spreads subjects that share a path prefix across the whole order", () => {
    // 20% of subjects share `folder-a/`. Independent keys put ~25% of them in
    // each quartile; a rank that leaks the path prefix (for example the raw
    // path, or a hash whose leading bytes follow the prefix) scores 0 in three
    // quartiles. Bound: at least 15% per quartile.
    for (const seed of SEEDS) {
      const order = permutation(seed, SUBJECTS);
      const perQuartile = [0, 0, 0, 0];
      order.forEach((subject, position) => {
        if (subject.kind === "comic" && subject.id.startsWith(COMMON_PREFIX)) {
          perQuartile[quartile(position)] = (perQuartile[quartile(position)] ?? 0) + 1;
        }
      });
      for (const count of perQuartile) {
        expect(count / COMMON_PREFIX_COUNT).toBeGreaterThanOrEqual(0.15);
      }
    }
  });

  it("keys media and comics separately even for the same id", () => {
    const seed = SEEDS[3];
    expect(galleryRandomOrderKey(seed, "media", "x")).not.toBe(
      galleryRandomOrderKey(seed, "comic", "x"),
    );
  });
});

describe("gallery random seed", () => {
  it("validates 32 lowercase hex characters only", () => {
    const isSeed = (value: string | number | null) =>
      GalleryRandomSeedSchema.safeParse(value).success;
    expect(isSeed("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSeed("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isSeed("0123456789abcdef0123456789abcde")).toBe(false);
    expect(isSeed(42)).toBe(false);
    expect(isSeed(null)).toBe(false);
    expect(GALLERY_RANDOM_SEED_PATTERN.source).toBe("^[0-9a-f]{32}$");
  });

  it("creates 32 lowercase hex characters from 16 random bytes", () => {
    const seed = createGalleryRandomSeed();
    expect(GalleryRandomSeedSchema.safeParse(seed).success).toBe(true);
    expect(createGalleryRandomSeed()).not.toBe(seed);
  });

  it("never returns its previous argument", () => {
    const previous = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
    let calls = 0;
    const seed = createGalleryRandomSeed(previous, (bytes) => {
      calls += 1;
      bytes.fill(calls === 1 ? 0x0f : 0xab);
    });
    expect(calls).toBe(2);
    expect(seed).toBe("abababababababababababababababab");
  });
});
