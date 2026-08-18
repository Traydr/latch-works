import { describe, expect, it } from "vitest";
import { createGatherRunState, GatherRunStateSchema } from "./gather-run";

describe("Gather Run state", () => {
  it("rejects unknown schema versions and malformed target identity", () => {
    expect(GatherRunStateSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
    expect(
      GatherRunStateSchema.safeParse({
        ...createGatherRunState({
          id: "run-1",
          tabId: 1,
          windowId: 1,
          tabUrl: "https://example.test",
          siteKey: "pixiv"
        }),
        tabId: "1"
      }).success
    ).toBe(false);
  });

  it("degrades accumulated state that no longer parses instead of dropping the run", () => {
    const parsed = GatherRunStateSchema.parse({
      ...createGatherRunState({
        id: "run-1",
        tabId: 1,
        windowId: 1,
        tabUrl: "https://example.test",
        siteKey: "pixiv"
      }),
      progress: "gone",
      log: [{ message: "kept" }, { message: 7 }],
      queuedCount: -3
    });

    expect(parsed.progress).toEqual({
      completed: 0,
      total: 0,
      saved: 0,
      skipped: 0,
      failed: 0,
      message: ""
    });
    expect(parsed.log).toEqual([{ message: "kept" }]);
    expect(parsed.queuedCount).toBe(0);
  });
});
