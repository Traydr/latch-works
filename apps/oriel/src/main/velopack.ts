import { createRequire } from "node:module";
import path from "node:path";

import type * as Velopack from "velopack";

/**
 * Answers Velopack, which installs and updates Oriel on Windows. Its installer and updater start
 * the app with arguments of their own (after install, before uninstall) and expect an answer
 * before anything else runs; the call may quit or restart the process. The package is staged
 * outside the asar, beside sharp, since it carries a native module.
 */
export function runVelopackHooks(): void {
  const packagedRequire = createRequire(
    path.join(process.resourcesPath, "node_modules", "velopack", "package.json"),
  );

  const velopack: typeof Velopack = packagedRequire("velopack");

  velopack.VelopackApp.build().run();
}
