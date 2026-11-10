import { describe, expect, it } from "vitest";
import {
  applyBrowseIntent,
  buildBrowseSearch,
  listingRequestFor,
  resolveBrowseState,
  resolveInitialRedirect,
  type SeededBrowseState,
  snapshotRequestFor,
} from "./browse-state-rules";
import {
  PERSISTED_BROWSE_STATE_DEFAULTS,
  PersistedBrowseStateSchema,
} from "./gallery-browse-storage";

const SEED = "0123456789abcdef0123456789abcdef";

function persisted(overrides: Partial<SeededBrowseState> = {}): SeededBrowseState {
  return { ...PERSISTED_BROWSE_STATE_DEFAULTS, randomSeed: SEED, ...overrides };
}

describe("resolveBrowseState", () => {
  it("forces recursive, comic, and folder modes off at the archive root", () => {
    const state = resolveBrowseState(
      { comic: true, recursive: true },
      persisted({ comicMode: true, recursive: true }),
    );

    expect(state).toMatchObject({
      comicMode: false,
      folderModesEnabled: false,
      path: "",
      recursive: false,
    });
  });

  it("implies recursive when comic is on inside a folder", () => {
    const state = resolveBrowseState({ comic: true, path: "photos" }, persisted());
    expect(state).toMatchObject({ comicMode: true, folderModesEnabled: true, recursive: true });
  });

  it("resolves the flags from the URL only; remembered flags never resurrect an absent one", () => {
    const stored = persisted({ comicMode: true, recursive: true });
    expect(
      resolveBrowseState({ comic: false, path: "photos", recursive: false }, stored),
    ).toMatchObject({ comicMode: false, recursive: false });
    // A URL without the flags means off — this is what lets a toggle turn a mode off.
    expect(resolveBrowseState({ path: "photos" }, stored)).toMatchObject({
      comicMode: false,
      recursive: false,
    });
    expect(resolveBrowseState({ path: "photos", recursive: true }, stored)).toMatchObject({
      comicMode: false,
      recursive: true,
    });
  });

  it("takes the sort mode, seed, and panel flag from storage", () => {
    const state = resolveBrowseState(
      { path: "photos" },
      persisted({ detailPanelOpen: false, sortMode: "random" }),
    );

    expect(state).toMatchObject({
      detailPanelOpen: false,
      randomSeed: SEED,
      sortMode: "random",
    });
  });

  it("takes query and selection from the URL only", () => {
    const state = resolveBrowseState({ media: "m-1", path: "photos", q: "cover" }, persisted());

    expect(state.query).toBe("cover");
    expect(state.selectedId).toBe("m-1");
    expect(resolveBrowseState({ path: "photos" }, persisted()).selectedId).toBeNull();
  });
});

describe("requests", () => {
  it("builds the snapshot request from the URL alone", () => {
    expect(snapshotRequestFor({ path: "photos", q: "x" })).toEqual({
      includeAllFolders: false,
      path: "photos",
      query: "x",
    });
    expect(snapshotRequestFor({}).path).toBe("");
  });

  it("carries excludes on the listing only while the folded recursive flag is on (Plan 054)", () => {
    const settings = { showImages: true, showVideos: true };
    const excludes = ["photos/kids"];

    const recursive = resolveBrowseState({ path: "photos", recursive: true }, persisted());
    expect(listingRequestFor(recursive, settings, excludes).excludedPaths).toEqual(excludes);

    // Comic mode folds into recursive, so excludes apply there too.
    const comic = resolveBrowseState({ comic: true, path: "photos" }, persisted());
    expect(listingRequestFor(comic, settings, excludes).excludedPaths).toEqual(excludes);

    const plain = resolveBrowseState({ path: "photos" }, persisted());
    expect(listingRequestFor(plain, settings, excludes).excludedPaths).toEqual([]);
  });

  it("builds the normalized listing request", () => {
    const state = resolveBrowseState({ path: "photos" }, persisted());

    expect(listingRequestFor(state, { showImages: true, showVideos: false })).toEqual({
      comicMode: false,
      excludedPaths: [],
      limit: 60,
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
  );

  it("navigates to a path, clears the selection and the search, and keeps the flags", () => {
    expect(
      applyBrowseIntent(folder, { path: "photos", type: "navigateToPath" }, remembered),
    ).toEqual({
      navigate: {
        search: { comic: true, media: undefined, path: "photos", q: undefined, recursive: true },
      },
    });
  });

  it("navigating to the root drops the flags and the search from the URL", () => {
    expect(applyBrowseIntent(folder, { path: "", type: "navigateToPath" }, remembered)).toEqual({
      navigate: {
        search: {
          comic: undefined,
          media: undefined,
          path: undefined,
          q: undefined,
          recursive: undefined,
        },
      },
    });
  });

  it("entering a folder from the root applies the remembered default flags", () => {
    const root = resolveBrowseState({}, persisted());

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
    const root = resolveBrowseState({}, persisted());
    expect(applyBrowseIntent(root, { next: true, type: "setRecursive" }, remembered)).toEqual({
      persisted: { comicMode: false, recursive: true },
    });
    expect(applyBrowseIntent(root, { next: true, type: "setComicMode" }, remembered)).toEqual({
      persisted: { comicMode: true, recursive: true },
    });
  });

  it("at the root, recursive on keeps the remembered comic flag and off clears it", () => {
    const root = resolveBrowseState({}, persisted());
    const comic = { comicMode: true, recursive: true };
    expect(applyBrowseIntent(root, { next: true, type: "setRecursive" }, comic)).toEqual({
      persisted: { comicMode: true, recursive: true },
    });
    expect(applyBrowseIntent(root, { next: false, type: "setRecursive" }, comic)).toEqual({
      persisted: { comicMode: false, recursive: false },
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
    const plain = resolveBrowseState({ path: "photos" }, persisted());
    expect(
      applyBrowseIntent(plain, { next: true, type: "setRecursive" }, remembered).navigate?.search,
    ).toMatchObject({
      comic: undefined,
      recursive: true,
    });
  });

  it("turning comic on turns recursive on; turning comic off turns recursive off (toolbar semantics)", () => {
    const plain = resolveBrowseState({ path: "photos" }, persisted());
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
    const result = applyBrowseIntent(folder, { type: "shuffle" }, remembered);

    expect(result.persisted?.sortMode).toBe("random");
    expect(result.persisted?.randomSeed).toMatch(/^[0-9a-f]{32}$/u);
    expect(result.persisted?.randomSeed).not.toBe(SEED);
  });
});

describe("resolveInitialRedirect", () => {
  it("redirects once to the last folder with its flags on a first visit without a path", () => {
    const stored = persisted({ comicMode: true, lastPath: "photos", recursive: false });
    expect(resolveInitialRedirect({ q: "cover" }, stored, false)).toEqual({
      comic: true,
      media: undefined,
      path: "photos",
      q: "cover",
      recursive: true,
    });
    expect(resolveInitialRedirect({}, stored, true)).toBeNull();
  });

  it("stays at the root after an explicit navigation from a persisted child folder", () => {
    const stored = persisted({ lastPath: "photos" });
    expect(resolveInitialRedirect({ path: "photos" }, stored, false)).toBeNull();
    expect(resolveInitialRedirect({}, stored, true)).toBeNull();
  });

  it("does nothing without a last path", () => {
    expect(resolveInitialRedirect({}, persisted({ lastPath: "" }), false)).toBeNull();
  });
});

describe("storage", () => {
  it("parses tolerantly, drops lastSelectedId, and rejects a non-hex seed", () => {
    expect(
      PersistedBrowseStateSchema.parse({
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
    expect(PersistedBrowseStateSchema.parse({ randomSeed: SEED }).randomSeed).toBe(SEED);
    expect(PersistedBrowseStateSchema.parse("junk")).toEqual(PERSISTED_BROWSE_STATE_DEFAULTS);
  });
});
