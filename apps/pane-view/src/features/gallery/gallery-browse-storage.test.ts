// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalStorageBrowseStorage,
  createMemoryBrowseStorage,
} from "./gallery-browse-storage";

/**
 * The recursive-excludes storage (Plan 054 Step 3): round trips, dedupe,
 * empty-list removal, tolerant parsing, and the rule that storage failures
 * never break browsing. The two existing keys are covered where the hook
 * tests exercise them; this file owns `pane-view.recursive-excludes`.
 */

const EXCLUDES_KEY = "pane-view.recursive-excludes";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("localStorage excluded child paths", () => {
  it("round-trips per browse path and leaves the other keys alone", () => {
    const storage = createLocalStorageBrowseStorage();
    localStorage.setItem("pane-view.state", '{"recursive":true}');

    storage.writeExcludedChildPaths("photos", ["photos/kids", "photos/teens"]);
    storage.writeExcludedChildPaths("videos", ["videos/raw"]);

    expect(storage.readExcludedChildPaths("photos")).toEqual(["photos/kids", "photos/teens"]);
    expect(storage.readExcludedChildPaths("videos")).toEqual(["videos/raw"]);
    expect(storage.readExcludedChildPaths("elsewhere")).toEqual([]);
    expect(localStorage.getItem("pane-view.state")).toBe('{"recursive":true}');
  });

  it("dedupes on write", () => {
    const storage = createLocalStorageBrowseStorage();
    storage.writeExcludedChildPaths("photos", ["photos/kids", "photos/kids", "photos/teens"]);
    expect(storage.readExcludedChildPaths("photos")).toEqual(["photos/kids", "photos/teens"]);
  });

  it("deletes the path's entry on an empty write so the record does not grow", () => {
    const storage = createLocalStorageBrowseStorage();
    storage.writeExcludedChildPaths("photos", ["photos/kids"]);
    storage.writeExcludedChildPaths("videos", ["videos/raw"]);

    storage.writeExcludedChildPaths("photos", []);

    expect(storage.readExcludedChildPaths("photos")).toEqual([]);
    expect(JSON.parse(localStorage.getItem(EXCLUDES_KEY) ?? "{}")).toEqual({
      videos: ["videos/raw"],
    });
  });

  it("reads a malformed record as empty, per entry and as a whole", () => {
    const storage = createLocalStorageBrowseStorage();

    localStorage.setItem(EXCLUDES_KEY, "not json");
    expect(storage.readExcludedChildPaths("photos")).toEqual([]);

    localStorage.setItem(EXCLUDES_KEY, '{"photos": 42, "videos": ["videos/raw"]}');
    expect(storage.readExcludedChildPaths("photos")).toEqual([]);
    expect(storage.readExcludedChildPaths("videos")).toEqual(["videos/raw"]);
  });

  it("recovers from a malformed record on the next write", () => {
    const storage = createLocalStorageBrowseStorage();
    localStorage.setItem(EXCLUDES_KEY, "not json");

    storage.writeExcludedChildPaths("photos", ["photos/kids"]);

    expect(storage.readExcludedChildPaths("photos")).toEqual(["photos/kids"]);
  });

  it("never throws when storage is unavailable or over quota", () => {
    const storage = createLocalStorageBrowseStorage();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });

    expect(storage.readExcludedChildPaths("photos")).toEqual([]);
    expect(() => storage.writeExcludedChildPaths("photos", ["photos/kids"])).not.toThrow();

    vi.stubGlobal("localStorage", undefined);
    expect(storage.readExcludedChildPaths("photos")).toEqual([]);
    expect(() => storage.writeExcludedChildPaths("photos", ["photos/kids"])).not.toThrow();
  });
});

describe("memory excluded child paths", () => {
  it("mirrors the localStorage behaviour", () => {
    const storage = createMemoryBrowseStorage({}, { photos: ["photos/kids"] });
    expect(storage.readExcludedChildPaths("photos")).toEqual(["photos/kids"]);

    storage.writeExcludedChildPaths("photos", ["photos/kids", "photos/kids", "photos/teens"]);
    expect(storage.recursiveExcludes).toEqual({ photos: ["photos/kids", "photos/teens"] });

    storage.writeExcludedChildPaths("photos", []);
    expect(storage.recursiveExcludes).toEqual({});
    expect(storage.readExcludedChildPaths("photos")).toEqual([]);
  });
});
