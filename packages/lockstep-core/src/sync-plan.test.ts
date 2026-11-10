import type { MediaItem } from "@latch-works/media-domain";
import { describe, expect, it } from "vitest";
import { createSyncPlan } from "./sync-plan.js";

function localImage(path: string, size: number, sha256: string): MediaItem {
  const name = path.slice(path.lastIndexOf("/") + 1);

  return {
    extension: "jpg",
    id: sha256,
    mediaType: "image",
    mtimeMs: 1,
    name,
    parentPath: path.slice(0, Math.max(0, path.lastIndexOf("/"))),
    path,
    sha256,
    size,
  };
}

describe("createSyncPlan", () => {
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

  it("keeps case-only twins on their own remote entries", () => {
    const plan = createSyncPlan(
      [localImage("sfw/Photo.jpg", 10, "aaa"), localImage("sfw/photo.jpg", 10, "bbb")],
      [
        { path: "sfw/Photo.jpg", size: 10, sha256: "aaa" },
        { path: "sfw/photo.jpg", size: 10, sha256: "bbb" },
      ],
    );

    expect(plan.counts).toEqual({ upload: 0, update: 0, keep: 2, delete: 0 });
    expect(plan.items.map((item) => [item.path, item.remote?.path])).toEqual([
      ["sfw/Photo.jpg", "sfw/Photo.jpg"],
      ["sfw/photo.jpg", "sfw/photo.jpg"],
    ]);
  });

  it("uploads the case-only twin a remote entry does not have", () => {
    const plan = createSyncPlan(
      [localImage("sfw/Photo.jpg", 10, "aaa"), localImage("sfw/photo.jpg", 10, "aaa")],
      [{ path: "sfw/Photo.jpg", size: 10, sha256: "aaa" }],
    );

    expect(plan.counts).toEqual({ upload: 1, update: 0, keep: 1, delete: 0 });
    expect(plan.items.find((item) => item.action === "upload")?.path).toBe("sfw/photo.jpg");
  });

  it("prefers a case-only match over a jpeg alias", () => {
    const plan = createSyncPlan(
      [localImage("sfw/photo.jpg", 10, "aaa"), localImage("sfw/photo.jpeg", 20, "bbb")],
      [{ path: "sfw/photo.JPG", size: 10, sha256: "aaa" }],
    );

    expect(plan.counts).toEqual({ upload: 1, update: 0, keep: 1, delete: 0 });
    expect(plan.items.find((item) => item.action === "keep")).toMatchObject({
      path: "sfw/photo.jpg",
      remote: { path: "sfw/photo.JPG" },
    });
  });
});
