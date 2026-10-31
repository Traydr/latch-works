import { type Random, seededRandom } from "./random.ts";

/**
 * What a fixture holds, worked out before any file is made. The plan is a pure function of the
 * profile and the seed, which is what makes a run resumable: a second run plans the same files,
 * skips those on disk and makes the rest.
 */

export type ProfileName = "full" | "smoke";

export type StillFormat = "avif" | "jpeg";

export type VideoCodec = "av1" | "h264" | "hevc";

export type DerivedKind = "convert" | "exact" | "reencode" | "resize";

interface DuplicateCounts {
  convert: number;
  exact: number;
  reencode: number;
  resize: number;
}

interface Profile {
  name: ProfileName;
  /** Which of the 20 still folders to make, by index. */
  stillFolders: readonly number[];
  stillsPerFolder: number;
  videosPerCodec: number;
  /** Which of the 40 comics to make, by index. */
  comics: readonly number[];
  duplicates: DuplicateCounts;
}

const ALL_STILL_FOLDERS = Array.from({ length: 20 }, (_, index) => index);

const ALL_COMICS = Array.from({ length: 40 }, (_, index) => index);

export const PROFILES: Record<ProfileName, Profile> = {
  full: {
    name: "full",
    stillFolders: ALL_STILL_FOLDERS,
    stillsPerFolder: 1000,
    videosPerCodec: 100,
    comics: ALL_COMICS,
    duplicates: { convert: 20, exact: 40, reencode: 20, resize: 20 },
  },
  // Folders 1, 2, 9 and 10 and files 1 to 50, so names still cross 9 → 10 where a plain string
  // sort and natural order disagree.
  smoke: {
    name: "smoke",
    stillFolders: [0, 1, 8, 9],
    stillsPerFolder: 50,
    videosPerCodec: 2,
    comics: [0, 32],
    duplicates: { convert: 2, exact: 3, reencode: 2, resize: 2 },
  },
};

/** One still made from another, for Tidy's duplicates and Spot variants later. */
export interface Derivation {
  kind: DerivedKind;
  /** The source still's path inside the fixture. */
  from: string;
}

export interface StillEntry {
  kind: "still";
  relPath: string;
  folder: number;
  number: number;
  /** The number drawn on the picture: folder × 1000 + file number. */
  label: number;
  format: StillFormat;
  /** The size the image displays at, after EXIF orientation. */
  width: number;
  height: number;
  /** Stored turned a quarter, with EXIF orientation 6 to turn it back, as a phone does. */
  rotated: boolean;
  mtimeMs: number;
  derived: Derivation | null;
}

export interface VideoEntry {
  kind: "video";
  relPath: string;
  codec: VideoCodec;
  label: number;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  toneHz: number;
  noiseSeed: number;
  mtimeMs: number;
}

export interface ComicPageEntry {
  kind: "comic-page";
  relPath: string;
  /** The comic's folder inside the fixture. */
  comic: string;
  comicIndex: number;
  page: number;
  format: "avif" | "jpeg" | "png";
  width: number;
  height: number;
  mtimeMs: number;
}

export interface FixturePlan {
  profile: ProfileName;
  seed: string;
  stills: StillEntry[];
  videos: VideoEntry[];
  comicPages: ComicPageEntry[];
  /** Comic folders, in plan order. */
  comics: string[];
}

/** Long edge × short edge of common camera and phone sensors, 1600 to 4000 pixels. */
const CAMERA_SIZES: readonly (readonly [number, number])[] = [
  [1600, 1200],
  [2048, 1536],
  [2400, 1600],
  [2560, 1440],
  [3000, 2000],
  [3264, 2448],
  [3840, 2160],
  [4000, 2250],
  [4000, 3000],
];

const VIDEO_SIZES: readonly (readonly [number, number])[] = [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
];

export const VIDEO_CODECS: readonly VideoCodec[] = ["h264", "hevc", "av1"];

const MTIME_START = Date.UTC(2016, 0, 1);

const MTIME_SPAN = Date.UTC(2026, 5, 30) - MTIME_START;

/** Whole seconds, so every file system keeps the same value. */
function pickMtime(random: Random): number {
  return MTIME_START + Math.floor((random.next() * MTIME_SPAN) / 1000) * 1000;
}

function stillFolderName(folder: number): string {
  return `Roll ${folder + 1}`;
}

/**
 * Each folder names its files the way one kind of camera does, unpadded so that `IMG_9` and
 * `IMG_10` sort differently by string and by natural order. One folder spells JPEG `.JPG`, one
 * `.jpeg`.
 */
function stillFileName(folder: number, number: number, format: StillFormat): string {
  const style = folder % 4;
  const stem = [`IMG_${number}`, `DSC_${number}`, `photo ${number}`, `PXL_${number}`][style];
  const jpegExtension = ["jpg", "JPG", "jpeg", "jpg"][style];

  return `${stem}.${format === "avif" ? "avif" : jpegExtension}`;
}

function planStill(seed: string, folder: number, number: number): StillEntry {
  const random = seededRandom(seed, `still:${folder}:${number}`);
  const format: StillFormat = random.chance(0.5) ? "avif" : "jpeg";
  const [long, short] = random.pick(CAMERA_SIZES);
  const portrait = random.chance(0.3);
  const rotated = format === "jpeg" && random.chance(0.03);

  return {
    kind: "still",
    relPath: `stills/${stillFolderName(folder)}/${stillFileName(folder, number, format)}`,
    folder,
    number,
    label: folder * 1000 + number,
    format,
    width: portrait ? short : long,
    height: portrait ? long : short,
    rotated,
    mtimeMs: pickMtime(random),
    derived: null,
  };
}

/**
 * Turns some stills into copies of others: exact copies, re-encodes at another quality, smaller
 * resizes and the other format. A target keeps its own name and folder, as a file imported twice
 * does, and takes the format its derivation gives it.
 */
function deriveDuplicates(seed: string, profile: Profile, stills: StillEntry[]): void {
  const random = seededRandom(seed, `duplicates:${profile.name}`);
  const used = new Set<number>();

  const pickUnused = (predicate: (entry: StillEntry) => boolean): number => {
    for (;;) {
      const index = random.int(0, stills.length - 1);
      const entry = stills[index];

      if (entry && !used.has(index) && predicate(entry)) {
        used.add(index);

        return index;
      }
    }
  };

  const kinds: DerivedKind[] = ["exact", "reencode", "resize", "convert"];

  for (const kind of kinds) {
    for (let count = 0; count < profile.duplicates[kind]; count += 1) {
      const source = stills[pickUnused(() => true)];

      if (!source) {
        continue;
      }

      // The copy sits in the same folder or a later one, as a later import would.
      const targetIndex = pickUnused((entry) => entry.folder >= source.folder);
      const target = stills[targetIndex];

      if (!target) {
        continue;
      }

      const scale = kind === "resize" ? random.pick([0.5, 0.6, 0.75]) : 1;
      const otherFormat: StillFormat = source.format === "avif" ? "jpeg" : "avif";
      const format = kind === "convert" ? otherFormat : source.format;
      const { folder, number } = target;

      stills[targetIndex] = {
        ...target,
        relPath: `stills/${stillFolderName(folder)}/${stillFileName(folder, number, format)}`,
        format,
        width: Math.round(source.width * scale),
        height: Math.round(source.height * scale),
        // Only an exact copy keeps the source's orientation tag; the others are decoded upright.
        rotated: kind === "exact" && source.rotated,
        derived: { kind, from: source.relPath },
      };
    }
  }
}

function planVideo(seed: string, codec: VideoCodec, number: number): VideoEntry {
  const random = seededRandom(seed, `video:${codec}:${number}`);
  const [long, short] = random.pick(VIDEO_SIZES);
  const portrait = random.chance(0.25);
  const fps = short <= 1080 ? random.pick([24, 25, 30, 30, 60]) : random.pick([24, 30]);

  return {
    kind: "video",
    relPath: `videos/${codec}/VID_${number}.mp4`,
    codec,
    label: VIDEO_CODECS.indexOf(codec) * 1000 + number,
    width: portrait ? short : long,
    height: portrait ? long : short,
    fps,
    seconds: random.int(6, 20),
    toneHz: random.int(220, 880),
    noiseSeed: random.int(1, 1_000_000),
    mtimeMs: pickMtime(random),
  };
}

const TITLE_FIRST = ["Copper", "Harbor", "Lantern", "Meadow", "Signal", "Velvet", "Winter", "Ash"];

const TITLE_SECOND = ["Lane", "Engine", "Tide", "Garden", "Circuit", "Atlas", "Hollow", "Crown"];

/**
 * Comics 0 to 31 are folders of pages straight under `comics/`; 32 to 39 are two volumes each of
 * four series, `comics/<series>/Vol_<n>`, whose series folder holds no pages and so is not a comic.
 * Names use `_` and `-`, which View shows as spaces.
 */
function comicFolder(index: number): string {
  if (index < 32) {
    const first = TITLE_FIRST[index % TITLE_FIRST.length];
    const second = TITLE_SECOND[Math.floor(index / TITLE_FIRST.length) % TITLE_SECOND.length];

    return `comics/${first}_${second}-${index + 1}`;
  }

  const series = Math.floor((index - 32) / 2);
  const volume = ((index - 32) % 2) + 1;

  return `comics/${TITLE_SECOND[series]}_Saga/Vol_${volume}`;
}

function comicPageName(index: number, page: number, extension: string): string {
  const style = index % 4;
  const stem = [`page_${page}`, String(page).padStart(2, "0"), `p${page}`, `Page ${page}`][style];

  return `${stem}.${extension}`;
}

function planComic(seed: string, index: number): ComicPageEntry[] {
  const random = seededRandom(seed, `comic:${index}`);
  const folder = comicFolder(index);
  const pages = random.int(12, 32);
  const roll = random.next();
  const format = roll < 0.05 ? "png" : roll < 0.3 ? "avif" : "jpeg";
  const width = random.int(12, 16) * 100;
  const height = Math.round(width * 1.5);
  const entries: ComicPageEntry[] = [];

  for (let page = 1; page <= pages; page += 1) {
    // Now and then a double-page spread, twice as wide.
    const spread = page > 1 && random.chance(0.06);
    const extension = format === "jpeg" ? "jpg" : format;

    entries.push({
      kind: "comic-page",
      relPath: `${folder}/${comicPageName(index, page, extension)}`,
      comic: folder,
      comicIndex: index,
      page,
      format,
      width: spread ? width * 2 : width,
      height,
      mtimeMs: pickMtime(random),
    });
  }

  return entries;
}

export function planFixture(profileName: ProfileName, seed: string): FixturePlan {
  const profile = PROFILES[profileName];
  const stills: StillEntry[] = [];

  for (const folder of profile.stillFolders) {
    for (let number = 1; number <= profile.stillsPerFolder; number += 1) {
      stills.push(planStill(seed, folder, number));
    }
  }

  deriveDuplicates(seed, profile, stills);

  const videos = VIDEO_CODECS.flatMap((codec) =>
    Array.from({ length: profile.videosPerCodec }, (_, index) => planVideo(seed, codec, index + 1)),
  );

  const comicPages = profile.comics.flatMap((index) => planComic(seed, index));

  return {
    profile: profile.name,
    seed,
    stills,
    videos,
    comicPages,
    comics: profile.comics.map(comicFolder),
  };
}
