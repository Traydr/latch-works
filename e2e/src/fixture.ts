import { compareByName } from "@latch-works/media-domain";

/**
 * The fixture archive the Pane View suite is seeded with. The manifest is the
 * oracle: tests derive expected orders, counts and comic eligibility from it,
 * and `scripts/make-fixture.ts` renders it to disk.
 *
 * Names are chosen to exercise natural ordering (1 < 2 < 10, A/b case
 * folding, non-ASCII), search escaping (`%` and `_`), comic eligibility (root
 * media, parent folders, video-only folders) and paging (> 60 items in one
 * folder).
 */
type FixtureKind = "gif" | "image" | "pdf" | "video";

export interface FixtureItem {
  kind: FixtureKind;
  /** Minutes after the fixture epoch; every item's mtime is distinct. */
  mtimeMinutes: number;
  name: string;
  /** Archive-relative path, POSIX separators. */
  path: string;
}

const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const BULK_COUNT = 70;

function item(folder: string, name: string, kind: FixtureKind): Omit<FixtureItem, "mtimeMinutes"> {
  return { kind, name, path: folder === "" ? name : `${folder}/${name}` };
}

const orderedItems = [
  item("", "root-image.png", "image"),
  item("comics/alpha", "1.jpg", "image"),
  item("comics/alpha", "2.jpg", "image"),
  item("comics/alpha", "10.jpg", "image"),
  item("comics/alpha", "A.jpg", "image"),
  item("comics/alpha", "b.jpg", "image"),
  item("comics/beta", "page-1.png", "image"),
  item("comics/beta", "page-2.png", "image"),
  item("comics/beta", "page-3.png", "image"),
  item("comics/beta", "anim.gif", "gif"),
  item("comics/nested/inner", "inner-1.png", "image"),
  item("comics/nested/inner", "inner-2.png", "image"),
  item("comics/nested/inner", "inner-3.png", "image"),
  item("videos", "clip-a.mp4", "video"),
  item("videos", "clip-b.mp4", "video"),
  item("mixed", "photo-1.jpg", "image"),
  item("mixed", "photo-2.jpg", "image"),
  item("mixed", "photo-3.jpg", "image"),
  item("mixed", "reel.mp4", "video"),
  item("docs", "guide.pdf", "pdf"),
  item("docs", "100%_done_1.png", "image"),
  item("docs", "100%_done_2.png", "image"),
  item("unicode", "Ünïcode.jpg", "image"),
  item("unicode", "zebra.jpg", "image"),
  // Deleted by the management spec; no other spec may depend on it.
  item("disposable", "gone-1.png", "image"),
  item("disposable", "gone-2.png", "image"),
  ...Array.from({ length: BULK_COUNT }, (_, index) =>
    item("bulk", `bulk-${String(index + 1).padStart(3, "0")}.png`, "image"),
  ),
];

/**
 * mtimes follow a fixed permutation of manifest order so that date order is
 * neither name order nor manifest order.
 */
function mtimePermutation(count: number): number[] {
  const minutes = Array.from({ length: count }, (_, index) => index);
  let state = 0x9e3779b9;
  for (let index = count - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const left = minutes[index];
    const right = minutes[swap];
    if (left === undefined || right === undefined) throw new Error("permutation bounds");
    minutes[index] = right;
    minutes[swap] = left;
  }
  return minutes;
}

const permutation = mtimePermutation(orderedItems.length);

export const FIXTURE_ITEMS: readonly FixtureItem[] = orderedItems.map((entry, index) => {
  const minutes = permutation[index];
  if (minutes === undefined) throw new Error("permutation bounds");
  return { ...entry, mtimeMinutes: minutes };
});

export function fixtureMtimeMs(entry: FixtureItem): number {
  return FIXTURE_EPOCH_MS + entry.mtimeMinutes * 60_000;
}

function fixtureParentPath(entry: FixtureItem): string {
  const slash = entry.path.lastIndexOf("/");
  return slash === -1 ? "" : entry.path.slice(0, slash);
}

/** Every folder path in the archive, including intermediate ones. */
export function fixtureFolderPaths(): string[] {
  const folders = new Set<string>();
  for (const entry of FIXTURE_ITEMS) {
    const segments = fixtureParentPath(entry).split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort();
}

export function isFixtureVideo(entry: FixtureItem): boolean {
  return entry.kind === "video";
}

export function isFixtureImageLike(entry: FixtureItem): boolean {
  return entry.kind === "image" || entry.kind === "gif";
}

/** Items in scope for a browse: direct children of `path`, or its whole subtree. */
export function fixtureItemsInScope(path: string, recursive: boolean): FixtureItem[] {
  return FIXTURE_ITEMS.filter((entry) => {
    const parent = fixtureParentPath(entry);
    if (!recursive) return parent === path;
    return path === "" || parent === path || parent.startsWith(`${path}/`);
  });
}

export type FixtureSortMode = "date-newest" | "date-oldest" | "name-asc" | "name-desc";

type FixtureComparator = (left: FixtureItem, right: FixtureItem) => number;

/** The documented ordering rules: natural name order, with dates breaking ties by name. */
const FIXTURE_COMPARATORS = {
  "date-newest": (left, right) =>
    fixtureMtimeMs(right) - fixtureMtimeMs(left) || compareByName(left, right),
  "date-oldest": (left, right) =>
    fixtureMtimeMs(left) - fixtureMtimeMs(right) || compareByName(left, right),
  "name-asc": (left, right) => compareByName(left, right),
  "name-desc": (left, right) => compareByName(right, left),
} satisfies Record<FixtureSortMode, FixtureComparator>;

export function sortFixtureItems(items: FixtureItem[], mode: FixtureSortMode): FixtureItem[] {
  return [...items].sort(FIXTURE_COMPARATORS[mode]);
}

export interface FixtureComic {
  folderPath: string;
  name: string;
  /** Page paths in reading order. */
  pages: string[];
}

/**
 * Comic eligibility: a leaf folder (no child folders) with at least one image
 * or gif, strictly inside the browse path. Root media and video-only folders
 * never form comics.
 */
export function fixtureComics(browsePath: string): FixtureComic[] {
  const folders = fixtureFolderPaths();
  const comics: FixtureComic[] = [];
  for (const folder of folders) {
    const inside = browsePath === "" || folder.startsWith(`${browsePath}/`);
    if (!inside) continue;
    const isLeaf = !folders.some((other) => other.startsWith(`${folder}/`));
    if (!isLeaf) continue;
    const pages = FIXTURE_ITEMS.filter(
      (entry) => fixtureParentPath(entry) === folder && isFixtureImageLike(entry),
    );
    if (pages.length === 0) continue;
    comics.push({
      folderPath: folder,
      name: folder.slice(folder.lastIndexOf("/") + 1),
      pages: sortFixtureItems(pages, "name-asc").map((entry) => entry.path),
    });
  }
  return comics;
}

/** The Lockstep desktop spec's own source: pushed after the seed, so it must not overlap it. */
export const LOCKSTEP_SOURCE_ITEMS: readonly FixtureItem[] = [
  { kind: "image", mtimeMinutes: 0, name: "desk-1.png", path: "desk/desk-1.png" },
  { kind: "image", mtimeMinutes: 1, name: "desk-2.png", path: "desk/desk-2.png" },
];
