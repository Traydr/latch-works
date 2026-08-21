#!/usr/bin/env node
/**
 * Captures every showcase screenshot from the real applications, in sequence:
 *
 * - Pane View: the running web app at localhost:3000 (capture-pane-view.mjs).
 * - Frame View: the real Electron app over CDP (capture-frame-view.mjs).
 * - Lockstep: the real Electron app doing a real plan + push against the local
 *   Pane View sync API (capture-lockstep.mjs).
 * - Gather Box: the real unpacked extension's side panel in Chrome
 *   (capture-gather-box.mjs).
 *
 * Prerequisites:
 * - Local services up (docs/localhost/compose.yaml) and the Pane View dev
 *   server running on port 3000 with the showcase archive synced.
 * - Sample media prepared: node scripts/prepare-showcase-media.mjs.
 * - Gather Box built: pnpm --filter @latch-works/gather-box build.
 *
 * Each per-app script is also runnable on its own.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const captures = [
  "capture-pane-view.mjs",
  "capture-frame-view.mjs",
  "capture-lockstep.mjs",
  "capture-gather-box.mjs",
];

const failures = [];
for (const script of captures) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [join(scriptsDir, script)], { stdio: "inherit" });
  if (result.status !== 0) {
    failures.push(script);
    console.error(`${script} failed with exit code ${result.status}.`);
  }
}

if (failures.length > 0) {
  console.error(`\nScreenshot capture failed for: ${failures.join(", ")}`);
  process.exit(1);
}

console.log("\nAll showcase screenshots captured from the real applications.");
