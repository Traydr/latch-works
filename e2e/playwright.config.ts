import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH, PANE_VIEW_URL } from "./src/env.ts";

/** Projects that run without the Pane View server: Glazier builds its own archive, and Oriel's
 * shell needs none. */
const STANDALONE_PROJECTS = new Set(["glazier", "oriel", "oriel-setup"]);

const selectedProjects = process.argv.flatMap((arg, index, all) => {
  if (arg === "--project") {
    return all[index + 1] === undefined ? [] : [all[index + 1]];
  }

  return arg.startsWith("--project=") ? [arg.slice("--project=".length)] : [];
});

/** Pane View starts unless every selected project is standalone (no selection runs them all). */
const needsPaneView =
  selectedProjects.length === 0 ||
  selectedProjects.some((name) => !STANDALONE_PROJECTS.has(name ?? ""));

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
      // View (Frame View in Oriel).
      dependencies: ["oriel-setup"],
      name: "frame-view",
      testDir: "./tests/frame-view",
      testMatch: /.*\.spec\.ts/,
    },
    {
      // Tidy (Glazier in Oriel) builds its own throwaway archive and needs no Pane View server.
      dependencies: ["oriel-setup"],
      name: "glazier",
      testDir: "./tests/glazier",
      testMatch: /.*\.spec\.ts/,
      timeout: 180_000,
    },
    {
      name: "oriel-setup",
      testDir: "./tests/oriel",
      testMatch: /.*\.setup\.ts/,
    },
    {
      dependencies: ["oriel-setup"],
      name: "oriel",
      testDir: "./tests/oriel",
      testMatch: /.*\.spec\.ts/,
    },
    {
      // Sync, in Oriel, pushes into the Pane View server the pane-view project started and seeded.
      dependencies: ["pane-view", "oriel-setup"],
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
  webServer: needsPaneView
    ? [
        {
          command: "tsx scripts/start-pane-view.ts",
          // Locally, an e2e server left running from a previous run is reused as-is
          // (already migrated, built and seeded); stop it to force a clean rebuild.
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          timeout: 300_000,
          url: `${PANE_VIEW_URL}/api/health`,
        },
      ]
    : [],
  workers: 1,
});
