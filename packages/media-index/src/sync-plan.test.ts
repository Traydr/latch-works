import { describe, expect, it } from "vitest";
import { createSyncPlan } from "./sync-plan.js";

describe("createSyncPlan", () => {
  it("plans uploads, keeps, updates, and deletes by path", () => {
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: "sfw/a.jpg",
          parentPath: "sfw",
          name: "a.jpg",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
        {
          id: "b",
          path: "sfw/b.jpg",
          parentPath: "sfw",
          name: "b.jpg",
          extension: "jpg",
          mediaType: "image",
          size: 20,
          mtimeMs: 1,
          sha256: "bbb",
        },
      ],
      [
        { path: "sfw/a.jpg", size: 10, sha256: "aaa" },
        { path: "sfw/b.jpg", size: 21, sha256: "old" },
        { path: "sfw/deleted.jpg", size: 1, sha256: "deleted" },
      ],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 1, keep: 1, delete: 1 });
  });
});
