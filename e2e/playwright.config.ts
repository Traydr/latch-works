import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH, PANE_VIEW_URL } from "./src/env.ts";

/**
 * One project per app surface. Each project owns its server lifecycle through
 * `webServer` and its seeding through a `*.setup.ts` dependency, so
 * `pnpm e2e:pane` stands alone.
 */
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [
    {
      name: "pane-view-setup",
      testDir: "./tests/pane-view",
      testMatch: /.*\.setup\.ts/,
      use: { baseURL: PANE_VIEW_URL },
    },
    {
      dependencies: ["pane-view-setup"],
      name: "pane-view",
      testDir: "./tests/pane-view",
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: PANE_VIEW_URL,
        storageState: AUTH_STATE_PATH,
        // Tall enough that the virtualised grid renders every fixture card.
        viewport: { height: 4000, width: 1400 },
      },
    },
    {
      name: "frame-view-setup",
      testDir: "./tests/frame-view",
      testMatch: /.*\.setup\.ts/,
    },
    {
      dependencies: ["frame-view-setup"],
      name: "frame-view",
      testDir: "./tests/frame-view",
      testMatch: /.*\.spec\.ts/,
    },
    {
      name: "lockstep-setup",
      testDir: "./tests/lockstep",
      testMatch: /.*\.setup\.ts/,
    },
    {
      // Pushes into the Pane View server the pane-view project started and seeded.
      dependencies: ["pane-view", "lockstep-setup"],
      name: "lockstep",
      testDir: "./tests/lockstep",
      testMatch: /.*\.spec\.ts/,
    },
  ],
  reporter: process.env.CI ? "github" : "list",
  retries: 0,
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "tsx scripts/start-pane-view.ts",
      // Locally, an e2e server left running from a previous run is reused as-is
      // (already migrated, built and seeded); stop it to force a clean rebuild.
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      timeout: 300_000,
      url: `${PANE_VIEW_URL}/api/health`,
    },
  ],
  workers: 1,
});
