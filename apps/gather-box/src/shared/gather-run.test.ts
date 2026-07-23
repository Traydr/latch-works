import { describe, expect, it } from "vitest";
import { createGatherRunState, normalizeGatherRunState } from "./gather-run";

describe("Gather Run state", () => {
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
});
