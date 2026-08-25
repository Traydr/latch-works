import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { z } from "zod";
import {
  AUTH_STATE_PATH,
  FIXTURE_ARCHIVE_DIR,
  PANE_VIEW_CREDENTIALS,
  PANE_VIEW_URL,
  REPO_ROOT,
} from "../../src/env.ts";
import { FIXTURE_ITEMS } from "../../src/fixture.ts";

const SnapshotResponseSchema = z.object({
  entries: z.array(z.object({ path: z.string(), sha256: z.string(), size: z.number() })),
  status: z.string(),
});

/**
 * Seeds the freshly migrated e2e database by pushing the fixture archive with
 * the real Lockstep CLI — the Lockstep → Pane View roundtrip is the seed —
 * then signs in once and stores the session for every spec.
 */
function runLockstep(args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const output: string[] = [];
    const child = spawn("pnpm", ["--filter", "@latch-works/lockstep", "start", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // The CLI persists its last-used source/api-url under $HOME; keep that out of
        // the developer's real config.
        HOME: home,
        LOCKSTEP_API_TOKEN: PANE_VIEW_CREDENTIALS.syncToken,
      },
    });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      const text = output.join("");
      if (code === 0) resolve(text);
      else reject(new Error(`lockstep ${args.join(" ")} exited with ${code}\n${text}`));
    });
  });
}

setup("push the fixture archive through Lockstep", async ({ request }) => {
  setup.setTimeout(300_000);
  const home = await mkdtemp(path.join(os.tmpdir(), "lockstep-e2e-home-"));
  const output = await runLockstep(
    ["push", "--source", FIXTURE_ARCHIVE_DIR, "--api-url", PANE_VIEW_URL, "--yes"],
    home,
  );
  // A reused server is already seeded (see playwright.config.ts); a fresh one takes the push.
  expect(output).toMatch(/Push finished: \d+ change\(s\) applied\.|Nothing to push\./);

  // A second push must find nothing to do: the remote snapshot matches the source.
  const again = await runLockstep(
    ["push", "--source", FIXTURE_ARCHIVE_DIR, "--api-url", PANE_VIEW_URL, "--yes"],
    home,
  );
  expect(again).toContain("Nothing to push.");

  const snapshot = await request.get("/api/sync/snapshot", {
    headers: { Authorization: `Bearer ${PANE_VIEW_CREDENTIALS.syncToken}` },
  });
  expect(snapshot.ok()).toBe(true);
  const body = SnapshotResponseSchema.parse(await snapshot.json());
  expect(body.entries.map((entry) => entry.path).sort()).toEqual(
    FIXTURE_ITEMS.map((entry) => entry.path).sort(),
  );
});

setup("sign in and store the session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(PANE_VIEW_CREDENTIALS.username);
  await page.getByLabel("Password").fill(PANE_VIEW_CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Archive browser" })).toBeVisible();
  await mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
});
