import { describe, expect, it } from "vitest";
import {
  createGatherRunState,
  isTerminalGatherRunPhase,
  normalizeGatherRunState
} from "./gather-run";

describe("Gather Run state", () => {
  it("creates a versioned preparing run with exact target identity", () => {
    const run = createGatherRunState({
      id: "run-1",
      tabId: 17,
      windowId: 4,
      tabUrl: "https://www.pixiv.net/artworks/1",
      siteKey: "pixiv",
      now: 123
    });

    expect(run).toMatchObject({
      schemaVersion: 1,
      id: "run-1",
      tabId: 17,
      windowId: 4,
      tabUrl: "https://www.pixiv.net/artworks/1",
      siteKey: "pixiv",
      createdAt: 123,
      updatedAt: 123,
      phase: "preparing"
    });
  });

  it("rejects unknown schema versions and malformed target identity", () => {
    expect(normalizeGatherRunState({ schemaVersion: 2 })).toBeNull();
    expect(
      normalizeGatherRunState({
        ...createGatherRunState({
          id: "run-1",
          tabId: 1,
          windowId: 1,
          tabUrl: "https://example.test",
          siteKey: "pixiv"
        }),
        tabId: "1"
      })
    ).toBeNull();
  });

  it("classifies only final phases as terminal", () => {
    expect(isTerminalGatherRunPhase("writing")).toBe(false);
    expect(isTerminalGatherRunPhase("permission-required")).toBe(false);
    expect(isTerminalGatherRunPhase("complete")).toBe(true);
    expect(isTerminalGatherRunPhase("failed")).toBe(true);
    expect(isTerminalGatherRunPhase("cancelled")).toBe(true);
    expect(isTerminalGatherRunPhase("interrupted")).toBe(true);
  });
});
