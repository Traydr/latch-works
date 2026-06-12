import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const lockstepCoreEntry = path.join(repoRoot, "packages/lockstep-core/dist/index.js");

if (!existsSync(lockstepCoreEntry)) {
  console.error(
    [
      "[lockstep] @latch-works/lockstep-core is not built.",
      "From the repo root, run:",
      "  pnpm -r --filter './packages/*' build",
      "Then start Lockstep with:",
      "  pnpm dev:lockstep",
      "or:",
      "  pnpm --filter @latch-works/lockstep-app start",
    ].join("\n"),
  );
  process.exit(1);
}
