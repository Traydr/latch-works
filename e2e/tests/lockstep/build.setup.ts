import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { electronChildEnv } from "../../src/env.ts";
import { LOCKSTEP_APP_DIR } from "../../src/lockstep.ts";

/** `electron-forge package` produces Lockstep's production `.vite/build`; E2E_SKIP_BUILD=1 reuses it. */
setup("package Lockstep", async () => {
  setup.setTimeout(300_000);
  const mainEntry = path.join(LOCKSTEP_APP_DIR, ".vite", "build", "main.js");
  if (process.env.E2E_SKIP_BUILD === "1") {
    await access(mainEntry);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "electron-forge", "package"], {
      cwd: LOCKSTEP_APP_DIR,
      env: electronChildEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`electron-forge package exited with ${code}`)),
    );
  });
  await access(mainEntry);
});
