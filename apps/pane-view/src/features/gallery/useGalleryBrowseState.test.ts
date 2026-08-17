import { describe, expect, it } from "vitest";
import {
  createMemoryBrowseStorage,
  PERSISTED_BROWSE_STATE_DEFAULTS,
  type PersistedBrowseState,
  parsePersistedBrowseState,
  resolveRootKey,
} from "./gallery-browse-storage";
import {
  applyBrowseIntent,
  browseSnapshotRequestFromSearch,
  buildBrowseSearch,
  foldBrowseFlags,
  listingRequestFor,
  PLACEHOLDER_RANDOM_SEED,
  resolveBrowseState,
  resolveInitialRedirect,
  snapshotRequestFor,
} from "./useGalleryBrowseState";

const SEED = "0123456789abcdef0123456789abcdef";
const OTHER_SEED = "fedcba9876543210fedcba9876543210";

function persisted(overrides: Partial<PersistedBrowseState> = {}): PersistedBrowseState {
  return { ...PERSISTED_BROWSE_STATE_DEFAULTS, randomSeed: SEED, ...overrides };
}

describe("resolveBrowseState", () => {
  it("forces recursive, comic, and folder modes off at the archive root", () => {
    const state = resolveBrowseState(
      { comic: true, recursive: true },
      persisted({ comicMode: true, recursive: true }),
      true,
    );
    expect(state).toMatchObject({
      comicMode: false,
      folderModesEnabled: false,
      path: "",
      recursive: false,
    });
  });

  it("implies recursive when comic is on inside a folder", () => {
    const state = resolveBrowseState({ comic: true, path: "photos" }, persisted(), true);
    expect(state).toMatchObject({ comicMode: true, folderModesEnabled: true, recursive: true });
  });

  it("resolves the flags from the URL only; remembered flags never resurrect an absent one", () => {
    const stored = persisted({ comicMode: true, recursive: true });
    expect(
      resolveBrowseState({ comic: false, path: "photos", recursive: false }, stored, true),
    ).toMatchObject({ comicMode: false, recursive: false });
    // A URL without the flags means off — this is what lets a toggle turn a mode off.
    expect(resolveBrowseState({ path: "photos" }, stored, true)).toMatchObject({
      comicMode: false,
      recursive: false,
    });
    expect(resolveBrowseState({ path: "photos", recursive: true }, stored, true)).toMatchObject({
      comicMode: false,
      recursive: true,
    });
  });

  it("states the folding rules once", () => {
    expect(foldBrowseFlags("", { comic: true, recursive: true })).toEqual({
      comicMode: false,
      folderModesEnabled: false,
      recursive: false,
    });
    expect(foldBrowseFlags("photos", { comic: true })).toEqual({
      comicMode: true,
      folderModesEnabled: true,
      recursive: true,
    });
    expect(foldBrowseFlags("photos", {})).toEqual({
      comicMode: false,
      folderModesEnabled: true,
      recursive: false,
    });
  });

  it("uses defaults and the placeholder seed before storage is read", () => {
    const state = resolveBrowseState({ path: "photos" }, persisted({ sortMode: "random" }), false);
    expect(state).toMatchObject({
      detailPanelOpen: true,
      hydrated: false,
      randomSeed: PLACEHOLDER_RANDOM_SEED,
      sortMode: "name-asc",
    });
    expect(resolveBrowseState({ path: "photos" }, null, true).hydrated).toBe(true);
  });

  it("takes query and selection from the URL only", () => {
    const state = resolveBrowseState(
      { media: "m-1", path: "photos", q: "cover" },
      persisted(),
      true,
    );
    expect(state.query).toBe("cover");
    expect(state.selectedId).toBe("m-1");
    expect(resolveBrowseState({ path: "photos" }, persisted(), true).selectedId).toBeNull();
  });
});

describe("requests", () => {
  it("builds one snapshot request with mediaLimit 0 in every mode", () => {
    const folder = resolveBrowseState({ path: "photos", q: "x" }, persisted(), true);
    expect(snapshotRequestFor(folder)).toEqual({
      comicMode: false,
      mediaLimit: 0,
      path: "photos",
      query: "x",
      recursive: false,
    });
    const comic = resolveBrowseState({ comic: true, path: "photos" }, persisted(), true);
    expect(snapshotRequestFor(comic)).toEqual({
      comicMode: true,
      mediaLimit: 0,
      path: "photos",
      query: undefined,
      recursive: true,
    });
    const root = resolveBrowseState({}, persisted(), true);
    expect(snapshotRequestFor(root).path).toBeUndefined();
  });

  it("gives the loader exactly the request the page builds, whatever is remembered", () => {
    const remembered = persisted({ comicMode: true, recursive: true });
    for (const search of [
      { comic: true, path: "photos", q: "cover", recursive: true },
      { path: "photos" },
      { path: "photos", recursive: true },
      {},
    ]) {
      expect(browseSnapshotRequestFromSearch(search)).toEqual(
        snapshotRequestFor(resolveBrowseState(search, remembered, true)),
      );
    }
    expect(browseSnapshotRequestFromSearch({ comic: true, recursive: true })).toMatchObject({
      comicMode: false,
      recursive: false,
    });
  });

  it("is deterministic for the same input", () => {
    const state = resolveBrowseState({ path: "photos" }, persisted(), true);
    expect(snapshotRequestFor(state)).toEqual(snapshotRequestFor(state));
    const settings = { showImages: true, showVideos: false };
    expect(listingRequestFor(state, settings)).toEqual(listingRequestFor(state, settings));
    expect(listingRequestFor(state, settings)).toEqual({
      comicMode: false,
      path: "photos",
      query: undefined,
      randomSeed: SEED,
      recursive: false,
      showImages: true,
      showVideos: false,
      sortMode: "name-asc",
    });
  });
});

describe("buildBrowseSearch", () => {
  const state = resolveBrowseState(
    { media: "m-1", path: "photos", q: "cover", recursive: true },
    persisted(),
    true,
  );

  it("keeps the current fields when the patch does not name them", () => {
    expect(buildBrowseSearch(state, {})).toEqual({
      comic: undefined,
      media: "m-1",
      path: "photos",
      q: "cover",
      recursive: true,
    });
  });

  it("clears a field when the patch names it with undefined", () => {
    expect(buildBrowseSearch(state, { media: undefined, q: undefined })).toMatchObject({
      media: undefined,
      q: undefined,
    });
  });

  it("drops both flags and writes no path for the root", () => {
    expect(buildBrowseSearch(state, { path: "" })).toEqual({
      comic: undefined,
      media: "m-1",
      path: undefined,
      q: "cover",
      recursive: undefined,
    });
  });

  it("writes only true flags and folds comic into recursive", () => {
    expect(buildBrowseSearch(state, { comic: true, recursive: false })).toMatchObject({
      comic: true,
      recursive: true,
    });
    expect(buildBrowseSearch(state, { recursive: false })).toMatchObject({
      comic: undefined,
      recursive: undefined,
    });
  });
});

describe("applyBrowseIntent", () => {
  const remembered = { comicMode: false, recursive: false };
  const folder = resolveBrowseState(
    { comic: true, media: "m-1", path: "photos/2026", q: "cover", recursive: true },
    persisted({ sortMode: "date-newest" }),
    true,
  );

  it("navigates to a path, clears the selection, and keeps the flags between folders", () => {
    expect(
      applyBrowseIntent(folder, { path: "photos", type: "navigateToPath" }, remembered),
    ).toEqual({
      navigate: {
        search: { comic: true, media: undefined, path: "photos", q: "cover", recursive: true },
      },
    });
  });

  it("navigating to the root drops the flags from the URL", () => {
    expect(applyBrowseIntent(folder, { path: "", type: "navigateToPath" }, remembered)).toEqual({
      navigate: {
        search: {
          comic: undefined,
          media: undefined,
          path: undefined,
          q: "cover",
          recursive: undefined,
        },
      },
    });
  });

  it("entering a folder from the root applies the remembered default flags", () => {
    const root = resolveBrowseState({}, persisted(), true);
    const enter = (flags: { comicMode: boolean; recursive: boolean }) =>
      applyBrowseIntent(root, { path: "photos", type: "navigateToPath" }, flags).navigate?.search;
    expect(enter({ comicMode: false, recursive: true })).toMatchObject({
      comic: undefined,
      path: "photos",
      recursive: true,
    });
    expect(enter({ comicMode: true, recursive: false })).toMatchObject({
      comic: true,
      path: "photos",
      recursive: true,
    });
    expect(enter(remembered)).toMatchObject({
      comic: undefined,
      path: "photos",
      recursive: undefined,
    });
  });

  it("at the root, the toggles write the remembered default instead of the URL", () => {
    const root = resolveBrowseState({}, persisted(), true);
    expect(applyBrowseIntent(root, { next: true, type: "setRecursive" }, remembered)).toEqual({
      persisted: { comicMode: false, recursive: true },
    });
    expect(applyBrowseIntent(root, { next: true, type: "setComicMode" }, remembered)).toEqual({
      persisted: { comicMode: true, recursive: true },
    });
  });

  it("submits a trimmed search and clears it on empty", () => {
    expect(
      applyBrowseIntent(folder, { query: "  hero ", type: "submitSearch" }, remembered).navigate
        ?.search,
    ).toMatchObject({
      media: undefined,
      q: "hero",
    });
    expect(
      applyBrowseIntent(folder, { query: "  ", type: "submitSearch" }, remembered).navigate?.search,
    ).toMatchObject({
      q: undefined,
    });
  });

  it("selects media by replacing the URL without scrolling", () => {
    expect(applyBrowseIntent(folder, { mediaId: "m-2", type: "selectMedia" }, remembered)).toEqual({
      navigate: {
        replace: true,
        resetScroll: false,
        search: { comic: true, media: "m-2", path: "photos/2026", q: "cover", recursive: true },
      },
    });
    expect(
      applyBrowseIntent(folder, { mediaId: null, type: "selectMedia" }, remembered).navigate?.search
        .media,
    ).toBeUndefined();
  });

  it("turning recursive off turns comic off; turning it on leaves comic alone", () => {
    expect(
      applyBrowseIntent(folder, { next: false, type: "setRecursive" }, remembered).navigate?.search,
    ).toMatchObject({
      comic: undefined,
      recursive: undefined,
    });
    const plain = resolveBrowseState({ path: "photos" }, persisted(), true);
    expect(
      applyBrowseIntent(plain, { next: true, type: "setRecursive" }, remembered).navigate?.search,
    ).toMatchObject({
      comic: undefined,
      recursive: true,
    });
  });

  it("turning comic on turns recursive on; turning comic off turns recursive off (toolbar semantics)", () => {
    const plain = resolveBrowseState({ path: "photos" }, persisted(), true);
    expect(
      applyBrowseIntent(plain, { next: true, type: "setComicMode" }, remembered).navigate?.search,
    ).toMatchObject({
      comic: true,
      recursive: true,
    });
    expect(
      applyBrowseIntent(folder, { next: false, type: "setComicMode" }, remembered).navigate?.search,
    ).toMatchObject({
      comic: undefined,
      recursive: undefined,
    });
  });

  it("writes local-only fields to persisted state, not the URL", () => {
    expect(
      applyBrowseIntent(folder, { next: "name-desc", type: "setSortMode" }, remembered),
    ).toEqual({
      persisted: { sortMode: "name-desc" },
    });
    expect(
      applyBrowseIntent(folder, { next: false, type: "setDetailPanelOpen" }, remembered),
    ).toEqual({
      persisted: { detailPanelOpen: false },
    });
  });

  it("shuffle sets random and changes the seed", () => {
    const result = applyBrowseIntent(folder, { type: "shuffle" }, remembered, (previous) => {
      expect(previous).toBe(SEED);
      return OTHER_SEED;
    });
    expect(result).toEqual({ persisted: { randomSeed: OTHER_SEED, sortMode: "random" } });
  });
});

describe("resolveInitialRedirect", () => {
  it("redirects once to the last folder with its flags on a first visit without a path", () => {
    const stored = persisted({ comicMode: true, lastPath: "photos", recursive: false });
    const first = resolveInitialRedirect({ q: "cover" }, stored, false);
    expect(first).toEqual({
      checked: true,
      redirectTo: { comic: true, media: undefined, path: "photos", q: "cover", recursive: true },
    });
    expect(resolveInitialRedirect({}, stored, first.checked)).toEqual({
      checked: true,
      redirectTo: null,
    });
  });

  it("stays at the root after an explicit navigation from a persisted child folder", () => {
    const stored = persisted({ lastPath: "photos" });
    const first = resolveInitialRedirect({ path: "photos" }, stored, false);
    expect(first).toEqual({ checked: true, redirectTo: null });
    expect(resolveInitialRedirect({}, stored, first.checked)).toEqual({
      checked: true,
      redirectTo: null,
    });
  });

  it("waits for storage and does nothing without a last path", () => {
    expect(resolveInitialRedirect({}, null, false)).toEqual({ checked: false, redirectTo: null });
    expect(resolveInitialRedirect({}, persisted({ lastPath: "" }), false)).toEqual({
      checked: true,
      redirectTo: null,
    });
  });
});

describe("storage", () => {
  it("parses tolerantly, drops lastSelectedId, and rejects a non-hex seed", () => {
    expect(
      parsePersistedBrowseState({
        comicMode: true,
        detailPanelOpen: "yes",
        lastPath: "photos",
        lastSelectedId: "m-1",
        randomSeed: 42,
        recursive: true,
        sortMode: "sideways",
      }),
    ).toEqual({
      comicMode: true,
      detailPanelOpen: true,
      lastPath: "photos",
      randomSeed: null,
      recursive: true,
      sortMode: "name-asc",
    });
    expect(parsePersistedBrowseState({ randomSeed: SEED }).randomSeed).toBe(SEED);
    expect(parsePersistedBrowseState("junk")).toEqual(PERSISTED_BROWSE_STATE_DEFAULTS);
  });

  it("keys root preferences by the first path segment and mirrors through the adapter", () => {
    expect(resolveRootKey("")).toBe("");
    expect(resolveRootKey("photos/2026/trip")).toBe("photos");
    const storage = createMemoryBrowseStorage();
    storage.writeRootPreferences("photos", {
      comicMode: true,
      recursive: true,
      sortMode: "random",
    });
    expect(storage.rootPreferences).toEqual({
      photos: { comicMode: true, recursive: true, sortMode: "random" },
    });
    expect(createMemoryBrowseStorage(null).read()).toBeNull();
    expect(createMemoryBrowseStorage().read()).toEqual(PERSISTED_BROWSE_STATE_DEFAULTS);
  });
});
