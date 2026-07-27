import { describe, expect, it } from "vitest";
import {
  GATHER_SOURCES,
  LISTED_GATHER_SOURCES,
  getGatherSource,
  getGatherSourceFromUrl
} from "./source-catalog";

describe("Gather Source catalog", () => {
  it("keeps context-menu eligibility inside always-on page access", () => {
    for (const source of GATHER_SOURCES) {
      expect(
        source.contextMenuMatches.every((match) => source.pageMatches.includes(match)),
        source.key
      ).toBe(true);
    }
  });

  it("owns every HTTPS permission with a reason", () => {
    for (const source of GATHER_SOURCES) {
      for (const permission of source.hostPermissions) {
        expect(permission.pattern, source.key).toMatch(/^https:\/\//);
        expect(permission.pattern, source.key).not.toBe("https://*/*");
        expect(permission.reason.trim(), source.key).not.toBe("");
      }
    }
  });

  it("rejects unknown persisted keys and ineligible URLs", () => {
    expect(getGatherSource("invented-source")).toBeNull();
    expect(getGatherSourceFromUrl("https://example.com/post/1")).toBeNull();
  });

  it("keeps unlisted sources collectable but out of enumerated surfaces", () => {
    const unlisted = GATHER_SOURCES.filter((source) => source.unlisted);
    expect(unlisted.length).toBeGreaterThan(0);

    for (const source of unlisted) {
      // Excluded from any browsable list (options page, generated docs).
      expect(LISTED_GATHER_SOURCES, source.key).not.toContain(source);
      // ...but still fully resolvable at runtime, so collection is unaffected.
      expect(getGatherSource(source.key), source.key).toBe(source);
    }
  });
});
