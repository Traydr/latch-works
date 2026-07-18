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

  it("treats case-only path differences as the same identity", () => {
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: "SFW/Photo.JPG",
          parentPath: "SFW",
          name: "Photo.JPG",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
      ],
      [{ path: "sfw/photo.jpg", size: 10, sha256: "aaa" }],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 1, delete: 0 });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.action).toBe("keep");
  });

  it("updates when case-only path matches differ by hash", () => {
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: "SFW/Photo.JPG",
          parentPath: "SFW",
          name: "Photo.JPG",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "newhash",
        },
      ],
      [{ path: "sfw/photo.jpg", size: 10, sha256: "oldhash" }],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 1, keep: 0, delete: 0 });
    expect(plan.items[0]?.action).toBe("update");
  });

  it("treats jpg and jpeg as the same identity", () => {
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: "sfw/photo.jpeg",
          parentPath: "sfw",
          name: "photo.jpeg",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
      ],
      [{ path: "sfw/photo.jpg", size: 10, sha256: "aaa" }],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 1, delete: 0 });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      action: "keep",
      path: "sfw/photo.jpeg",
      remote: { path: "sfw/photo.jpg" },
    });
  });

  it("deletes alias duplicate remotes after keeping the matched identity", () => {
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: "sfw/photo.jpg",
          parentPath: "sfw",
          name: "photo.jpg",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
      ],
      [
        { path: "sfw/photo.jpg", size: 10, sha256: "aaa" },
        { path: "sfw/photo.jpeg", size: 10, sha256: "aaa" },
      ],
    );

    // Remote-side jpg/jpeg collision disables aliasing, so the exact .jpg match is kept
    // and the leftover .jpeg twin is planned for delete.
    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 1, delete: 1 });
    expect(plan.items.find((item) => item.action === "delete")?.path).toBe("sfw/photo.jpeg");
  });

  it("keeps both jpg and jpeg when both exist locally and remotely", () => {
    const plan = createSyncPlan(
      [
        {
          id: "jpg",
          path: "sfw/photo.jpg",
          parentPath: "sfw",
          name: "photo.jpg",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
        {
          id: "jpeg",
          path: "sfw/photo.jpeg",
          parentPath: "sfw",
          name: "photo.jpeg",
          extension: "jpg",
          mediaType: "image",
          size: 20,
          mtimeMs: 1,
          sha256: "bbb",
        },
      ],
      [
        { path: "sfw/photo.jpg", size: 10, sha256: "aaa" },
        { path: "sfw/photo.jpeg", size: 20, sha256: "bbb" },
      ],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 2, delete: 0 });
    expect(plan.items.map((item) => item.path).sort()).toEqual(["sfw/photo.jpeg", "sfw/photo.jpg"]);
  });

  it("does not overwrite a remote jpeg when local has both jpg and jpeg", () => {
    const plan = createSyncPlan(
      [
        {
          id: "jpg",
          path: "sfw/photo.jpg",
          parentPath: "sfw",
          name: "photo.jpg",
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "jpg-hash",
        },
        {
          id: "jpeg",
          path: "sfw/photo.jpeg",
          parentPath: "sfw",
          name: "photo.jpeg",
          extension: "jpg",
          mediaType: "image",
          size: 20,
          mtimeMs: 1,
          sha256: "jpeg-hash",
        },
      ],
      [{ path: "sfw/photo.jpeg", size: 20, sha256: "jpeg-hash" }],
    );

    expect(plan.counts).toEqual({ upload: 1, update: 0, keep: 1, delete: 0 });
    expect(plan.items.find((item) => item.action === "upload")?.path).toBe("sfw/photo.jpg");
    expect(plan.items.find((item) => item.action === "keep")).toMatchObject({
      path: "sfw/photo.jpeg",
      remote: { path: "sfw/photo.jpeg" },
    });
  });

  it("treats NFC and NFD paths as the same identity", () => {
    const nfc = "sfw/café.jpg".normalize("NFC");
    const nfd = "sfw/café.jpg".normalize("NFD");
    const plan = createSyncPlan(
      [
        {
          id: "a",
          path: nfd,
          parentPath: "sfw",
          name: nfd.slice(nfd.lastIndexOf("/") + 1),
          extension: "jpg",
          mediaType: "image",
          size: 10,
          mtimeMs: 1,
          sha256: "aaa",
        },
      ],
      [{ path: nfc, size: 10, sha256: "aaa" }],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 1, delete: 0 });
  });
});
