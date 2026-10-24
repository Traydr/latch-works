import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  chooseFolder,
  type GlazierSession,
  latestToast,
  launchGlazier,
  waitForJobs,
} from "../../src/glazier.ts";
import { buildGlazierArchive, heldFiles, streamCodecs } from "../../src/glazier-archive.ts";

let archive: string;

let session: GlazierSession;

const exists = (relPath: string) => stat(path.join(archive, ...relPath.split("/")));

test.beforeAll(async () => {
  test.setTimeout(120_000);
  archive = await buildGlazierArchive();
  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test("Tidy up runs every step but duplicates as one change, and one Undo takes it all back", async () => {
  test.setTimeout(300_000);

  const { window } = session;

  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, archive);
  await waitForJobs(window);

  await window
    .locator("main")
    .getByRole("button", { name: /^Tidy up/ })
    .click();
  await expect(latestToast(window)).toContainText("Tidied up", { timeout: 240_000 });
  await waitForJobs(window);

  // Clean up fixed the extension, held the junk and removed the empty folder.
  await expect(exists("photos/cover.avif")).resolves.toBeTruthy();
  await expect(exists("empty")).rejects.toThrow();
  // Duplicates are not a step: the identical copy waits for review, beside its original.
  await expect(exists("dup/with-sound-copy.mp4")).resolves.toBeTruthy();
  await expect(exists("clips/with-sound.mp4")).resolves.toBeTruthy();
  // The silent soundtrack is gone, the picture kept.
  expect(await streamCodecs(path.join(archive, "clips", "silent-track.mp4"))).toEqual(["h264"]);
  // Convert ran last, and left the similar pair for review to compare.
  await expect(exists("clips/talk.mp4")).resolves.toBeTruthy();
  await expect(exists("photos/forest.avif")).resolves.toBeTruthy();
  await expect(exists("photos/sunset.png")).resolves.toBeTruthy();

  const heldAfterTidy = await heldFiles(session.userDataDir, archive);

  expect(heldAfterTidy).toEqual(
    expect.arrayContaining([
      ".DS_Store",
      "clips/silent-track.mp4",
      "clips/talk.mov",
      "photos/forest.png",
    ]),
  );
  expect(heldAfterTidy).not.toContain("dup/with-sound-copy.mp4");

  await latestToast(window).getByRole("button", { name: "Undo" }).click();
  await expect(latestToast(window)).toContainText("Undid", { timeout: 120_000 });
  await waitForJobs(window);

  for (const original of [
    ".DS_Store",
    "clips/talk.mov",
    "photos/forest.png",
    "photos/cover.jpg",
    "empty",
  ]) {
    await expect(exists(original), original).resolves.toBeTruthy();
  }

  expect(await streamCodecs(path.join(archive, "clips", "silent-track.mp4"))).toContain("aac");

  // Undoing a conversion holds what it made, so the originals are back and the results wait in
  // holding until it is emptied.
  const held = await heldFiles(session.userDataDir, archive);

  expect(held).toEqual(expect.arrayContaining(["clips/talk.mp4", "photos/forest.avif"]));
  expect(held).not.toEqual(expect.arrayContaining(["clips/talk.mov", "photos/forest.png"]));
});
