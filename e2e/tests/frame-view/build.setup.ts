import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { FRAME_VIEW_DIR } from "../../src/frame-view.ts";

/**
 * `electron-forge package` is the only supported way to produce Frame View's
 * production `.vite/build` (Forge injects the renderer defines). It takes about
 * ten seconds; E2E_SKIP_BUILD=1 reuses the existing output.
 */
setup("package Frame View", async () => {
  setup.setTimeout(300_000);
  const mainEntry = path.join(FRAME_VIEW_DIR, ".vite", "build", "main.js");
  if (process.env.E2E_SKIP_BUILD === "1") {
    await access(mainEntry);
    return;
  }
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "electron-forge", "package"], {
      cwd: FRAME_VIEW_DIR,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`electron-forge package exited with ${code}`)),
    );
  });
  await access(mainEntry);
});
