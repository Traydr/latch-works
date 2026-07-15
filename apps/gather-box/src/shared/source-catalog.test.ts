import { describe, expect, it } from "vitest";
import { GATHER_SOURCES, getGatherSource, getGatherSourceFromUrl } from "./source-catalog";

describe("Gather Source catalog", () => {
  it("has unique stable keys and labels with complete policy", () => {
    expect(new Set(GATHER_SOURCES.map((source) => source.key)).size).toBe(GATHER_SOURCES.length);
    expect(new Set(GATHER_SOURCES.map((source) => source.label)).size).toBe(GATHER_SOURCES.length);

    for (const source of GATHER_SOURCES) {
      expect(source.urlPatterns.length, source.key).toBeGreaterThan(0);
      expect(source.pageMatches.length, source.key).toBeGreaterThan(0);
      expect(source.hostPermissions.length, source.key).toBeGreaterThan(0);
      expect(source.contextMenuMatches.length, source.key).toBeGreaterThan(0);
      expect(source.downloadUrlPatterns.length, source.key).toBeGreaterThan(0);
      expect(source.collectorEntry, source.key).toMatch(/^content\/collectors\/.+\.js$/);
      expect(source.collectorModule, source.key).toMatch(/^src\/content\/collectors\/.+\.ts$/);
      expect(source.outputKinds.length, source.key).toBeGreaterThan(0);
      expect(source.save.pathTemplate, source.key).toContain("<root>");
    }
  });

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
});
