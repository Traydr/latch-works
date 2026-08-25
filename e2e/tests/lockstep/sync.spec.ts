import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { LOCKSTEP_SOURCE_DIR, PANE_VIEW_CREDENTIALS, PANE_VIEW_URL } from "../../src/env.ts";
import { LOCKSTEP_SOURCE_ITEMS } from "../../src/fixture.ts";
import { type LockstepSession, launchLockstep, readStat, stageButton } from "../../src/lockstep.ts";

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

/** The header's plan legend renders "<label> <count>" pairs; read one count. */
async function readPlanCount(label: "upload" | "keep"): Promise<string> {
  // The plan list below also labels rows "upload"; the legend comes first in the DOM.
  const pair = session.window.locator("span", { hasText: new RegExp(`^${label}$`) }).locator("..");
  return (await pair.first().innerText()).replace(label, "").trim();
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

  const active = window.getByRole("button", { name: "Active profile" });
  if ((await active.innerText()).trim() !== PROFILE_NAME) {
    await active.click();
    await window.getByRole("option", { name: PROFILE_NAME }).click();
  }
  await expect(active).toHaveText(PROFILE_NAME);
  await expect(window.getByText(LOCKSTEP_SOURCE_DIR, { exact: true })).toBeVisible();
});

test("plan reports the source as uploads, push lands them in Pane View", async ({ request }) => {
  const { window } = session;
  await stageButton(window, "Plan").click();
  await expect
    .poll(() => readPlanCount("upload"), { timeout: 60_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));

  await stageButton(window, "Push").click();
  await expect
    .poll(() => readStat(window, "pushed"), { timeout: 120_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));
  await expect(stageButton(window, "Push")).toBeEnabled({ timeout: 60_000 });
  expect(await readStat(window, "failed")).toBe("0");

  const snapshot = await request.get(`${PANE_VIEW_URL}/api/sync/snapshot`, {
    headers: { Authorization: `Bearer ${PANE_VIEW_CREDENTIALS.syncToken}` },
  });
  expect(snapshot.ok()).toBe(true);
  const remotePaths = SnapshotResponseSchema.parse(await snapshot.json()).entries.map(
    (entry) => entry.path,
  );
  for (const item of LOCKSTEP_SOURCE_ITEMS) expect(remotePaths).toContain(item.path);
});

test("a second plan has nothing to upload", async () => {
  const { window } = session;
  await stageButton(window, "Plan").click();
  await expect
    .poll(() => readPlanCount("keep"), { timeout: 60_000 })
    .toBe(String(LOCKSTEP_SOURCE_ITEMS.length));
  expect(await readPlanCount("upload")).toBe("0");
});

test("the sync token never reaches the settings file in the clear", async () => {
  const settings = await readFile(path.join(session.userDataDir, "lockstep-settings.json"), "utf8");
  expect(settings).toContain(PROFILE_NAME);
  expect(settings).not.toContain(PANE_VIEW_CREDENTIALS.syncToken);
});
