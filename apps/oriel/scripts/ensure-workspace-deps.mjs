import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const repoRoot = path.resolve(appRoot, "../..");

/** The workspace packages Oriel's modes load from their `dist`, which `pnpm start` never builds. */
const packages = ["app-data", "glazier-core", "lockstep-core", "media-format"];

const missing = packages.filter(
  (name) => !existsSync(path.join(repoRoot, "packages", name, "dist", "index.js")),
);

if (missing.length > 0) {
  console.error(
    [
      `[oriel] ${missing.map((name) => `@latch-works/${name}`).join(", ")} not built.`,
      "From the repo root, run:",
      "  pnpm -r --filter './packages/*' build",
      "Then start Oriel with:",
      "  pnpm --filter @latch-works/oriel start",
    ].join("\n"),
  );
  process.exit(1);
}
