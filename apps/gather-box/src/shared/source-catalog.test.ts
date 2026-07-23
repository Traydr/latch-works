import { describe, expect, it } from "vitest";
import { GATHER_SOURCES, getGatherSource, getGatherSourceFromUrl } from "./source-catalog";

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
});
