import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const repoRoot = path.resolve(appRoot, "../..");

const coreEntry = path.join(repoRoot, "packages/glazier-core/dist/index.js");

if (!existsSync(coreEntry)) {
  console.error(
    [
      "[glazier] @latch-works/glazier-core is not built.",
      "From the repo root, run:",
      "  pnpm -r --filter './packages/*' build",
      "Then start Glazier with:",
      "  pnpm --filter @latch-works/glazier-app start",
    ].join("\n"),
  );
  process.exit(1);
}
