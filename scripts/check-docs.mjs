import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownRoots = [
  "AGENTS.md",
  "README.md",
  "CONTEXT.md",
  "docs",
  "apps/pane-view/README.md",
  "apps/frame-view/README.md",
  "apps/gather-box/README.md",
  "apps/lockstep/README.md",
  "apps/lockstep-cli/README.md",
  "apps/showcase/src/content/docs",
];

// Keep this list synchronized with apps/pane-view/src/env/server.ts. Parsing Zod here would
// duplicate its semantics, so this explicitly covers the non-default server contract.
const requiredPaneServerEnv = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "PANE_VIEW_USERNAME",
  "PANE_VIEW_PASSWORD",
  "PANE_VIEW_SYNC_TOKEN",
  "SHUTTER_EDGE_URL",
  "SHUTTER_CONTROL_URL",
  "SHUTTER_SPACE_ID",
  "SHUTTER_SPACE_API_TOKEN",
  "SHUTTER_CAPABILITY_KEYS",
  "SHUTTER_CAPABILITY_KID",
];

const documentedScripts = [
  ["package.json", "dev:pane"],
  ["package.json", "dev:lockstep"],
  ["package.json", "dev:showcase"],
  ["package.json", "start:lockstep"],
  ["apps/pane-view/package.json", "dev"],
  ["apps/pane-view/package.json", "build"],
  ["apps/pane-view/package.json", "start"],
  ["apps/pane-view/package.json", "typecheck"],
  ["apps/pane-view/package.json", "test"],
  ["apps/pane-view/package.json", "db:generate"],
  ["apps/pane-view/package.json", "db:migrate"],
  ["apps/frame-view/package.json", "start"],
  ["apps/frame-view/package.json", "package"],
  ["apps/frame-view/package.json", "make"],
  ["apps/frame-view/package.json", "publish"],
  ["apps/lockstep/package.json", "start"],
  ["apps/lockstep-cli/package.json", "start"],
  ["apps/gather-box/package.json", "build"],
];

async function markdownFiles(path) {
  const info = await stat(path);
  if (info.isFile()) {
    return /\.mdx?$/.test(path) ? [path] : [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => markdownFiles(join(path, entry.name))));
  return files.flat();
}

async function checkMarkdownLinks(files) {
  const failures = [];
  const linkPattern = /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const target = match[1].split("#", 1)[0];
      if (!target || target.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(target)) {
        continue;
      }

      const destination = resolve(dirname(file), target);
      try {
        await stat(destination);
      } catch {
        failures.push(`${relative(root, file)} -> ${target}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Broken repository-relative Markdown links:\n${failures.join("\n")}`);
  }
}

async function checkDocumentedScripts() {
  for (const [packagePath, script] of documentedScripts) {
    const packageJson = JSON.parse(await readFile(join(root, packagePath), "utf8"));
    if (!packageJson.scripts?.[script]) {
      throw new Error(`Missing documented script ${script} in ${packagePath}`);
    }
  }
}

async function checkPaneEnvironment() {
  const example = await readFile(join(root, "docs/localhost/latch-works.env.example"), "utf8");
  const keys = new Set(
    example
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z\d_]*)=/)?.[1])
      .filter(Boolean),
  );
  const missing = requiredPaneServerEnv.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    throw new Error(`Localhost environment example is missing: ${missing.join(", ")}`);
  }
}

async function selfTest() {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "latch-works-docs-check-"));
  const fixture = join(fixtureDirectory, "broken.md");
  await writeFile(fixture, "[broken](missing.md)\n");
  try {
    await checkMarkdownLinks([fixture]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing.md")) {
      return;
    }
    throw error;
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
  throw new Error("Broken-link fixture did not fail the documentation checker");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
  console.log("Temporary broken-link fixture failed as expected.");
}

await checkMarkdownLinks(
  await Promise.all(markdownRoots.map((path) => markdownFiles(join(root, path)))).then((files) =>
    files.flat(),
  ),
);
await checkDocumentedScripts();
await checkPaneEnvironment();
console.log("Documentation contracts passed.");
