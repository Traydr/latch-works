import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { z } from "zod";
import {
  FIXTURE_ARCHIVE_DIR,
  LOCKSTEP_SOURCE_DIR,
  PANE_VIEW_CREDENTIALS,
  PANE_VIEW_URL,
} from "../../src/env.ts";
import { LOCKSTEP_SOURCE_ITEMS } from "../../src/fixture.ts";
import {
  actionButton,
  dismissRunPanel,
  type LockstepSession,
  launchLockstep,
  readPlanCount,
  readStat,
} from "../../src/lockstep.ts";

const SnapshotResponseSchema = z.object({
  entries: z.array(z.object({ path: z.string() })),
});

const PROFILE_NAME = "E2E archive";

let session: LockstepSession;

test.beforeAll(async () => {
  session = await launchLockstep();
});

test.afterAll(async () => {
  await session.app.close();
});

async function readRemotePaths(request: APIRequestContext): Promise<string[]> {
  const snapshot = await request.get(`${PANE_VIEW_URL}/api/sync/snapshot`, {
    headers: { Authorization: `Bearer ${PANE_VIEW_CREDENTIALS.syncToken}` },
  });

  expect(snapshot.ok()).toBe(true);

  return SnapshotResponseSchema.parse(await snapshot.json()).entries.map((entry) => entry.path);
}

test.describe.configure({ mode: "serial" });

test("a profile is created against the running Pane View", async () => {
  const { window } = session;
  await window.getByTitle("Add profile").click();
  await window.getByLabel("Profile name").fill(PROFILE_NAME);
  await window.getByLabel("Pane View API URL").fill(PANE_VIEW_URL);
  await window.locator("#profile-source-root").fill(LOCKSTEP_SOURCE_DIR);
  await window.getByLabel("Sync API token").fill(PANE_VIEW_CREDENTIALS.syncToken);
  await window.getByRole("button", { name: "Save profile" }).click();

  const profile = window
    .getByRole("navigation", { name: "Profiles" })
    .getByRole("button", { name: new RegExp(`^${PROFILE_NAME}`) });

  if ((await profile.getAttribute("aria-current")) !== "true") {
    await profile.click();
  }

  await expect(profile).toHaveAttribute("aria-current", "true");
  await expect(window.getByText(LOCKSTEP_SOURCE_DIR, { exact: true })).toBeVisible();
});

test("plan reports the source as uploads, push lands them in Pane View", async ({ request }) => {
  const { window } = session;
  await actionButton(window, "plan").click();
  await expect
    .poll(() => readPlanCount(window, "upload"), { timeout: 60_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));

  await actionButton(window, "push").click();
  await expect
    .poll(() => readStat(window, "pushed"), { timeout: 120_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));
  await expect(window.getByText("Push complete")).toBeVisible({ timeout: 60_000 });
  expect(await readStat(window, "failed")).toBe("0");
  await dismissRunPanel(window);

  const remotePaths = await readRemotePaths(request);

  for (const item of LOCKSTEP_SOURCE_ITEMS) expect(remotePaths).toContain(item.path);
});

test("a second plan has nothing to upload", async () => {
  const { window } = session;
  await actionButton(window, "plan").click();
  await expect
    .poll(() => readPlanCount(window, "keep"), { timeout: 60_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));
  expect(await readPlanCount(window, "upload")).toBe("0");
});

test("prune deletes the reviewed plan's deletes once, skipping a file back in the source", async ({
  request,
}) => {
  const { window } = session;
  // The previous test's plan is the reviewed one: every seeded path is a delete from this source.
  const localPaths = LOCKSTEP_SOURCE_ITEMS.map((item) => item.path);
  const plannedDeletes = (await readRemotePaths(request)).filter((p) => !localPaths.includes(p));
  expect(await readPlanCount(window, "delete")).toBe(String(plannedDeletes.length));

  // After review, one planned delete's file comes back locally; prune must leave it alone.
  const returning = "root-image.png";
  expect(plannedDeletes).toContain(returning);
  await copyFile(
    path.join(FIXTURE_ARCHIVE_DIR, returning),
    path.join(LOCKSTEP_SOURCE_DIR, returning),
  );

  try {
    let confirmMessage = "";
    window.once("dialog", (dialog) => {
      confirmMessage = dialog.message();
      void dialog.accept();
    });

    await actionButton(window, "prune").click();
    await expect
      .poll(() => readStat(window, "deleted"), { timeout: 120_000 })
      .toBe(String(plannedDeletes.length - 1));
    await expect(window.getByText("Prune complete")).toBeVisible({ timeout: 60_000 });
    expect(confirmMessage).toContain(`Delete ${plannedDeletes.length} remote entries`);
    expect(await readStat(window, "failed")).toBe("0");

    // The plan is spent: a second Prune cannot re-run the same list.
    await expect(actionButton(window, "prune")).toBeDisabled();
    await expect(actionButton(window, "prune")).toHaveAttribute("title", /Run Plan again/);

    expect((await readRemotePaths(request)).sort()).toEqual([...localPaths, returning].sort());
  } finally {
    await rm(path.join(LOCKSTEP_SOURCE_DIR, returning), { force: true });
  }
});

test("the sync token never reaches the settings file in the clear", async () => {
  const settings = await readFile(path.join(session.userDataDir, "lockstep-settings.json"), "utf8");
  expect(settings).toContain(PROFILE_NAME);
  expect(settings).not.toContain(PANE_VIEW_CREDENTIALS.syncToken);
});
