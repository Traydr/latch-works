import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  chooseFolder,
  type GlazierSession,
  latestToast,
  launchGlazier,
  openView,
  waitForJobs,
} from "../../src/glazier.ts";
import {
  buildGlazierArchive,
  heldFiles as heldIn,
  ORIGINAL_MTIME,
  streamCodecs,
} from "../../src/glazier-archive.ts";

let archive: string;

let session: GlazierSession;

const heldFiles = () => heldIn(session.userDataDir, archive);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  archive = await buildGlazierArchive();
  session = await launchGlazier();
});

test.afterAll(async () => {
  await session?.app.close();
  await rm(archive, { force: true, recursive: true });
});

test.describe.configure({ mode: "serial" });

test("a new folder is scanned and Overview lists what to do with it", async () => {
  const { window } = session;

  await window.getByRole("button", { name: /Choose folder/i }).click();
  await chooseFolder(window, archive);
  // The scan, then the similar and sound analysis it queues in the background.
  await waitForJobs(window);

  const step = (id: string) => window.locator(`[data-step="${id}"]`);

  await expect(window.getByText("15 files", { exact: false }).first()).toBeVisible();
  // The copy of with-sound.mp4, left for review rather than Tidy up, and sunset.png with its
  // resized JPEG.
  await expect(step("identical")).toContainText("1 set of identical copies");
  await expect(window.getByText("1 set of similar versions")).toBeVisible();
  await expect(step("silent")).toContainText("1 video");
  await expect(step("cleanup")).toContainText("1 junk file");
  await expect(step("cleanup")).toContainText("1 empty folder");
  await expect(step("cleanup")).toContainText("1 wrong extension");
  await expect(step("convert")).toHaveAttribute("data-state", "todo");
});

test("the resized JPEG is grouped with the picture it came from", async () => {
  const { window } = session;
  const tile = (name: string) => window.locator(`[data-file-name="${name}"]`);

  await openView(window, "duplicates");
  await window.locator("[data-set-key]", { hasText: "sunset" }).first().click();

  await expect(tile("sunset-small.jpg")).toHaveAttribute("data-keep", "false");
  await expect(tile("sunset.png")).toHaveAttribute("data-keep", "true");
  await expect(window.locator("[data-decide]")).toHaveText(/^Keep 1/);

  // ⇧2 keeps the resized one as well, which makes them not duplicates; nothing changes on disk.
  await window.keyboard.press("Shift+Digit2");
  await expect(tile("sunset-small.jpg")).toHaveAttribute("data-keep", "true");
  await expect(window.locator("[data-decide]")).toContainText("Not duplicates");
  await window.keyboard.press("Shift+Digit2");
  await expect(tile("sunset-small.jpg")).toHaveAttribute("data-keep", "false");
  await expect(stat(path.join(archive, "photos", "sunset-small.jpg"))).resolves.toBeTruthy();
});

test("silent tracks are told apart from sound", async () => {
  const { window } = session;

  const sound = (label: string) =>
    window.getByRole("menuitemcheckbox", { name: new RegExp(label) });

  await openView(window, "library");
  await window.getByRole("button", { name: /^Filter/ }).click();

  // The GIF is still an image here; no-audio.mp4 and the three silent test patterns lack a track.
  await expect(sound("No audio track")).toContainText("4");
  await expect(sound("Silent track")).toContainText("1");
  await expect(sound("Has sound")).toContainText("4");
  await window.keyboard.press("Escape");
});

test("Return keeps the suggested copy and moves on, and Undo brings the set back", async () => {
  const { window } = session;
  const copy = path.join(archive, "dup", "with-sound-copy.mp4");

  await openView(window, "duplicates");
  await window.getByRole("button", { name: /^Identical/ }).click();
  await window.locator("[data-set-key^='exact:']").first().click();
  // The copy-style name loses to the original.
  await expect(window.locator('[data-file-name="with-sound.mp4"]')).toHaveAttribute(
    "data-keep",
    "true",
  );

  await window.keyboard.press("Enter");
  await expect(latestToast(window)).toContainText("Kept with-sound.mp4");
  await expect(stat(copy)).rejects.toThrow();
  expect(await heldFiles()).toEqual(["dup/with-sound-copy.mp4"]);

  await latestToast(window).getByRole("button", { name: "Undo" }).click();
  await waitForJobs(window);
  await expect.poll(async () => (await stat(copy).catch(() => null))?.isFile() ?? false).toBe(true);
  expect(await heldFiles()).toEqual([]);
  // The set is back in the queue, in focus.
  await expect(window.locator('[data-file-name="with-sound-copy.mp4"]')).toBeVisible();
});

test("Convert turns stills into AVIF and video into MP4, keeping dates, and leaves versions under review", async () => {
  const { window } = session;

  await openView(window, "convert");
  await window
    .locator("main")
    .getByRole("button", { name: /^Convert \d+/ })
    .click();
  await expect(latestToast(window)).toContainText("Converted", { timeout: 180_000 });
  await waitForJobs(window);

  for (const [converted, codec] of [
    ["clips/talk.mp4", "h264"],
    ["clips/scene.mp4", "h264"],
    ["clips/loop.mp4", "h264"],
    ["clips/sticker.mp4", "h264"],
    ["clips/odd.mp4", "h264"],
    ["clips/old.mp4", "h264"],
  ] as const) {
    expect(await streamCodecs(path.join(archive, converted))).toContain(codec);
  }

  // sunset.png and its resized JPEG are a similar set nobody has reviewed yet, so both stay as
  // they are for review to compare.
  await expect(stat(path.join(archive, "photos", "sunset.png"))).resolves.toBeTruthy();
  await expect(stat(path.join(archive, "photos", "sunset.avif"))).rejects.toThrow();

  for (const converted of [
    "photos/forest.avif",
    "clips/talk.mp4",
    "clips/scene.mp4",
    "clips/loop.mp4",
    "clips/sticker.mp4",
    "clips/odd.mp4",
    "clips/old.mp4",
  ]) {
    const written = await stat(path.join(archive, converted));

    expect(Math.trunc(written.mtimeMs / 1000), converted).toBe(ORIGINAL_MTIME.getTime() / 1000);
  }

  expect(await heldFiles()).toEqual(
    expect.arrayContaining([
      "clips/loop.gif",
      "clips/old.mp4",
      "clips/odd.webm",
      "clips/scene.webm",
      "clips/sticker.webm",
      "clips/talk.mov",
      "photos/forest.png",
    ]),
  );
  await expect(window.getByText("Everything is AVIF or MP4")).toBeVisible();
});

test("Clean up fixes the extension, holds the junk and removes the empty folder", async () => {
  const { window } = session;

  await openView(window, "cleanup");
  await window
    .locator("main")
    .getByRole("button", { name: /^Clean up \d+/ })
    .click();
  await expect(latestToast(window)).toContainText("Cleaned up");
  await waitForJobs(window);

  await expect(stat(path.join(archive, "photos", "cover.avif"))).resolves.toBeTruthy();
  await expect(stat(path.join(archive, "empty"))).rejects.toThrow();
  expect(await heldFiles()).toEqual(expect.arrayContaining([".DS_Store"]));
  await expect(window.getByText("Nothing to clean up")).toBeVisible();
});
