import type { BigIntStats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { normalizePathForCompare } from "@latch-works/media-domain";
import { z } from "zod";
import { resolveLocalFilePath } from "./push-helpers.js";

/** The fs error codes that mean nothing exists at a path. */
export const MissingPathErrorSchema = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

/**
 * Coarse file systems (FAT, some network shares) store folder times in steps of up to 2 s, so a
 * change in the same step as the listing would leave the times unchanged. A listing taken this
 * close to the folder's last change is not reused; 1 s of the window allows for clock skew.
 */
const RACY_LISTING_WINDOW_NS = 3_000_000_000n;

type NameKind = "file" | "folder";

interface DirectoryListing {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  names: string[];
  /** Normalized name → the entry names with that spelling, built per kind on first use. */
  byKind: Map<NameKind, Map<string, string[]>>;
}

function isSameDirectoryState(listing: DirectoryListing, current: BigIntStats): boolean {
  return (
    listing.dev === current.dev &&
    listing.ino === current.ino &&
    listing.mtimeNs === current.mtimeNs &&
    listing.ctimeNs === current.ctimeNs
  );
}

function normalizeName(name: string, kind: NameKind): string {
  return normalizePathForCompare(name, { canonicalizeExtensions: kind === "file" });
}

/**
 * Finds entries under `sourceRoot` that planning treats as the same path, reusing each folder's
 * listing and its normalized names while the folder is unchanged. A folder is stat-ed on every
 * lookup: adding, removing, or renaming an entry changes its modified or change time, and a
 * different folder at the path changes its device or inode, so a file restored at any point is
 * still seen. Listings too close to the folder's last change are read again every time.
 */
export class DirectoryAliasIndex {
  readonly #listings = new Map<string, DirectoryListing>();

  readonly #sourceRoot: string;

  constructor(sourceRoot: string) {
    this.#sourceRoot = sourceRoot;
  }

  /**
   * Archive paths that planning would treat as `archivePath`: folders match across case and
   * Unicode spelling, the file name also across the jpeg↔jpg alias.
   */
  async findEquivalentPaths(archivePath: string): Promise<string[]> {
    const segments = archivePath.split("/");
    let candidates = [""];

    for (const [index, segment] of segments.entries()) {
      const kind: NameKind = index === segments.length - 1 ? "file" : "folder";
      const wanted = normalizeName(segment, kind);
      const next: string[] = [];

      for (const parent of candidates) {
        for (const name of await this.#namesMatching(parent, wanted, kind)) {
          next.push(parent ? `${parent}/${name}` : name);
        }
      }

      candidates = next;
    }

    return candidates;
  }

  async #namesMatching(archiveDir: string, wanted: string, kind: NameKind): Promise<string[]> {
    const listing = await this.#readListing(archiveDir);

    if (!listing) {
      return [];
    }

    let index = listing.byKind.get(kind);

    if (!index) {
      index = new Map();

      for (const name of listing.names) {
        const key = normalizeName(name, kind);
        const spellings = index.get(key);

        if (spellings) {
          spellings.push(name);
        } else {
          index.set(key, [name]);
        }
      }

      listing.byKind.set(kind, index);
    }

    return index.get(wanted) ?? [];
  }

  async #readListing(archiveDir: string): Promise<DirectoryListing | undefined> {
    const directoryPath = archiveDir
      ? resolveLocalFilePath(this.#sourceRoot, archiveDir)
      : this.#sourceRoot;

    // Stat before listing: a change between the two leaves newer times than the stored ones, so
    // the next lookup reads the folder again instead of trusting a stale listing.
    const listedAtNs = BigInt(Date.now()) * 1_000_000n;
    const current = await readMissingAsUndefined(() => stat(directoryPath, { bigint: true }));
    const cached = this.#listings.get(archiveDir);

    if (cached && current && isSameDirectoryState(cached, current)) {
      return cached;
    }

    this.#listings.delete(archiveDir);

    if (!current?.isDirectory()) {
      return undefined;
    }

    const names = await readMissingAsUndefined(() => readdir(directoryPath));

    if (!names) {
      return undefined;
    }

    const listing: DirectoryListing = {
      byKind: new Map(),
      ctimeNs: current.ctimeNs,
      dev: current.dev,
      ino: current.ino,
      mtimeNs: current.mtimeNs,
      names,
    };

    const lastChangeNs = current.mtimeNs > current.ctimeNs ? current.mtimeNs : current.ctimeNs;

    if (listedAtNs - lastChangeNs > RACY_LISTING_WINDOW_NS) {
      this.#listings.set(archiveDir, listing);
    }

    return listing;
  }
}

async function readMissingAsUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (MissingPathErrorSchema.safeParse(error).success) {
      return undefined;
    }

    throw error;
  }
}
