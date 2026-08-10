import { gzipSync } from "node:zlib";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const reports = resolve(root, ".build-meta");
const development = process.env.NODE_ENV === "development";
const sourceCatalog = JSON.parse(await readFile(resolve(root, "source-catalog.json"), "utf8"));
const common = {
  absWorkingDir: root,
  bundle: true,
  logLevel: "silent",
  metafile: true,
  minify: !development,
  sourcemap: development ? "inline" : false,
  target: "chrome145"
};

const packagedFiles = [
  "ui/gather-box.css",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.css",
  "options/options.html",
  "options/options.css",
  "offscreen/offscreen.html",
  "rules/pixiv-referer.json",
  "rules/redgifs-api.json",
  "assets/fonts/NotoSerif-Regular.ttf",
  "assets/fonts/NotoSerif-Italic.ttf",
  "assets/fonts/NotoSerif-Bold.ttf",
  "assets/fonts/NotoSerif-BoldItalic.ttf",
  "assets/fonts/OFL.txt",
  "assets/icons/icon16.png",
  "assets/icons/icon32.png",
  "assets/icons/icon48.png",
  "assets/icons/icon128.png"
];

await verifyVersionAgreement();
const { manifest, permissionReport } = await generateManifest();
await rm(dist, { force: true, recursive: true });
await rm(reports, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await Promise.all(packagedFiles.map(copyPackagedFile));
await mkdir(resolve(dist, "codecs"), { recursive: true });
await copyFile(
  resolve(root, "node_modules/@jsquash/avif/codec/enc/avif_enc.wasm"),
  resolve(dist, "codecs/avif_enc.wasm")
);
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const pages = await build({
  ...common,
  entryPoints: {
    "sidepanel/sidepanel": resolve(root, "src/sidepanel/index.ts"),
    "options/options": resolve(root, "src/options/index.ts"),
    "offscreen/offscreen": resolve(root, "src/offscreen/index.ts"),
    "workers/avif-encoder": resolve(root, "src/gather/avif-encoder.worker.ts")
  },
  chunkNames: "chunks/[name]-[hash]",
  entryNames: "[dir]/[name]",
  format: "esm",
  outdir: dist,
  splitting: true
});

const background = await build({
  ...common,
  entryPoints: {
    "background/service-worker": resolve(root, "src/background/index.ts")
  },
  entryNames: "[dir]/[name]",
  format: "esm",
  outdir: dist
});

const content = await build({
  ...common,
  entryPoints: Object.fromEntries([
    ["content/page-shortcuts", resolve(root, "src/content/page-shortcuts-entry.ts")],
    ...sourceCatalog.map((source) => [
      source.collectorEntry.replace(/\.js$/, ""),
      resolve(root, "src/content/entries", `${basename(source.collectorEntry, ".js")}.ts`)
    ])
  ]),
  entryNames: "[dir]/[name]",
  format: "iife",
  outdir: dist
});

const metafiles = { pages: pages.metafile, background: background.metafile, content: content.metafile };
await mkdir(reports, { recursive: true });
await writeFile(resolve(reports, "permissions.json"), `${JSON.stringify(permissionReport, null, 2)}\n`);
await Promise.all(
  Object.entries(metafiles).map(([name, metafile]) =>
    writeFile(resolve(reports, `${name}.json`), `${JSON.stringify(metafile, null, 2)}\n`)
  )
);

const report = await createArtifactReport(metafiles);
await writeFile(resolve(reports, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
enforceBudgets(report, metafiles);

for (const [name, measurement] of Object.entries(report.categories)) {
  process.stdout.write(`${name.padEnd(24)} ${formatBytes(measurement.raw).padStart(9)} raw  ${formatBytes(measurement.gzip).padStart(9)} gzip\n`);
}

async function copyPackagedFile(relativePath) {
  const target = resolve(dist, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, relativePath), target);
}

async function verifyVersionAgreement() {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.base.json"), "utf8"));
  if (packageJson.version !== manifest.version) {
    throw new Error(
      `Gather Box version mismatch: package.json=${packageJson.version}, manifest.json=${manifest.version}`
    );
  }
}

async function generateManifest() {
  const base = JSON.parse(await readFile(resolve(root, "manifest.base.json"), "utf8"));
  const permissionOwners = new Map();
  const pageMatches = new Set();
  for (const source of sourceCatalog) {
    for (const match of [...source.pageMatches, ...source.contextMenuMatches]) {
      validateHttpsMatch(match, source.key);
    }
    for (const match of source.pageMatches) pageMatches.add(match);
    for (const permission of source.hostPermissions) {
      validateHttpsMatch(permission.pattern, source.key);
      const owners = permissionOwners.get(permission.pattern) ?? [];
      owners.push({ source: source.key, reason: permission.reason });
      permissionOwners.set(permission.pattern, owners);
    }
    if (!source.collectorEntry || source.outputKinds.length === 0 || !source.save) {
      throw new Error(`Gather Source ${source.key} is missing collector, output, or save policy.`);
    }
    await access(resolve(root, source.collectorModule)).catch(() => {
      throw new Error(`Gather Source ${source.key} selects missing collector ${source.collectorModule}.`);
    });
  }

  const hostPermissions = [...permissionOwners.keys()].sort();
  const permissionReport = hostPermissions.map((pattern) => ({
    pattern,
    owners: permissionOwners.get(pattern)
  }));
  return {
    manifest: {
      ...base,
      host_permissions: hostPermissions,
      content_scripts: [
        {
          matches: [...pageMatches].sort(),
          js: ["content/page-shortcuts.js"],
          run_at: "document_start"
        }
      ]
    },
    permissionReport
  };
}

function validateHttpsMatch(pattern, sourceKey) {
  if (!pattern.startsWith("https://") || pattern.startsWith("https://*/*") || pattern === "<all_urls>") {
    throw new Error(`Gather Source ${sourceKey} declares an unsafe Chrome match: ${pattern}`);
  }
}

async function createArtifactReport(metafiles) {
  const pageEntry = findOutput(metafiles.pages, "sidepanel/sidepanel.js");
  const offscreenEntry = findOutput(metafiles.pages, "offscreen/offscreen.js");
  const storyChunk = Object.entries(metafiles.pages.outputs).find(([, output]) =>
    Object.keys(output.inputs).some((input) => input.endsWith("src/gather/fanfiction-story.ts"))
  )?.[0];
  if (!storyChunk) {
    throw new Error("Generated-story chunk was not emitted as an isolated local module.");
  }
  const mediaConversionChunk = Object.entries(metafiles.pages.outputs).find(([, output]) =>
    Object.keys(output.inputs).some((input) =>
      input.endsWith("src/gather/archive-media-transformer.ts")
    )
  )?.[0];
  if (!mediaConversionChunk) {
    throw new Error("Media-conversion chunk was not emitted as an isolated local module.");
  }
  const avifWorkerEntry = findOutput(metafiles.pages, "workers/avif-encoder.js");
  const mediaConversionOutputs = getOutputGraph(
    metafiles.pages,
    [mediaConversionChunk, avifWorkerEntry]
  );
  const mediaConversionJs = await measureFiles(
    [...mediaConversionOutputs].filter((path) => path.endsWith(".js")).map(outputPath)
  );
  const mediaConversionWasm = await measureFiles([resolve(dist, "codecs/avif_enc.wasm")]);

  verifyContentIsolation(metafiles.content);
  const collectorMeasurements = Object.fromEntries(
    await Promise.all(
      sourceCatalog.map(async (source) => [
        `collector ${source.key} JS`,
        await measureOutputGraph(metafiles.content, findOutput(metafiles.content, source.collectorEntry))
      ])
    )
  );
  const categories = {
    "side panel eager JS": await measureOutputGraph(metafiles.pages, pageEntry),
    "offscreen base JS": await measureOutputGraph(
      metafiles.pages,
      offscreenEntry,
      new Set([storyChunk, mediaConversionChunk])
    ),
    "generated-story JS": await measureOutputGraph(metafiles.pages, storyChunk),
    "media conversion JS": mediaConversionJs,
    "media conversion WASM": mediaConversionWasm,
    "media conversion assets": sumMeasurements(mediaConversionJs, mediaConversionWasm),
    "service worker JS": await measureOutputGraph(
      metafiles.background,
      findOutput(metafiles.background, "background/service-worker.js")
    ),
    "page shortcuts JS": await measureOutputGraph(
      metafiles.content,
      findOutput(metafiles.content, "content/page-shortcuts.js")
    ),
    ...collectorMeasurements,
    fonts: await measureDirectory(resolve(dist, "assets/fonts"), (name) => name.endsWith(".ttf")),
    icons: await measureDirectory(resolve(dist, "assets/icons"), () => true),
    "total JS": await measureJsOutputs(metafiles),
    "total dist": await measureDirectory(dist, () => true)
  };
  return {
    schemaVersion: 1,
    mode: development ? "development" : "release",
    storyChunk: storyChunk.replace(/^dist\//, ""),
    mediaConversionChunks: [...mediaConversionOutputs].map((path) => path.replace(/^dist\//, "")),
    categories
  };
}

function verifyContentIsolation(metafile) {
  const shortcutOutput = metafile.outputs[findOutput(metafile, "content/page-shortcuts.js")];
  const shortcutInputs = Object.keys(shortcutOutput.inputs);
  if (shortcutInputs.some((input) => input.includes("/collectors/"))) {
    throw new Error("The always-on page-shortcut entry imports Gather Source collector code.");
  }

  for (const source of sourceCatalog) {
    const output = metafile.outputs[findOutput(metafile, source.collectorEntry)];
    const collectorInputs = Object.keys(output.inputs).filter((input) => input.includes("/collectors/"));
    const expected = source.collectorModule.replace(/^src\//, "src/");
    if (collectorInputs.length !== 1 || collectorInputs[0] !== expected) {
      throw new Error(
        `Collector entry ${source.key} crossed source seams: ${collectorInputs.join(", ") || "none"}`
      );
    }
  }
}

function findOutput(metafile, suffix) {
  const output = Object.keys(metafile.outputs).find((path) => path.endsWith(suffix));
  if (!output) {
    throw new Error(`Expected build output was not emitted: ${suffix}`);
  }
  return output;
}

async function measureOutputGraph(metafile, entry, excluded = new Set()) {
  return measureFiles([...getOutputGraph(metafile, [entry], excluded)].map(outputPath));
}

function getOutputGraph(metafile, entries, excluded = new Set()) {
  const paths = new Set();
  const visit = (path) => {
    if (paths.has(path) || excluded.has(path)) return;
    paths.add(path);
    for (const imported of metafile.outputs[path]?.imports ?? []) {
      const resolved = imported.path.startsWith("dist/")
        ? imported.path
        : `dist/${imported.path.replace(/^\.\//, "")}`;
      if (metafile.outputs[resolved]) visit(resolved);
    }
  };
  for (const entry of entries) visit(entry);
  return paths;
}

async function measureJsOutputs(metafiles) {
  const outputs = new Set(
    Object.values(metafiles).flatMap((metafile) =>
      Object.keys(metafile.outputs).filter((path) => path.endsWith(".js"))
    )
  );
  return measureFiles([...outputs].map(outputPath));
}

function outputPath(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

async function measureFiles(paths) {
  let raw = 0;
  let gzip = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
  }
  return { raw, gzip };
}

function sumMeasurements(...measurements) {
  return measurements.reduce(
    (total, measurement) => ({
      raw: total.raw + measurement.raw,
      gzip: total.gzip + measurement.gzip
    }),
    { raw: 0, gzip: 0 }
  );
}

async function measureDirectory(directory, include) {
  const files = await walk(directory);
  return measureFiles(files.filter((path) => include(basename(path))));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : Promise.resolve([path]);
      })
    )
  ).flat();
}

function enforceBudgets(report, metafiles) {
  const budgets = {
    "side panel eager JS": 150_000,
    "offscreen base JS": 180_000,
    "generated-story JS": 1_300_000,
    "media conversion JS": 300_000,
    "media conversion WASM": 3_600_000,
    "media conversion assets": 3_900_000,
    "service worker JS": 150_000,
    "page shortcuts JS": 10_000,
    "total JS": 1_800_000,
    "total dist": 8_000_000
  };
  for (const source of sourceCatalog) budgets[`collector ${source.key} JS`] = 40_000;
  const failures = Object.entries(budgets).filter(
    ([name, budget]) => report.categories[name].raw > budget
  );
  if (failures.length === 0) return;

  const largestInputs = Object.values(metafiles)
    .flatMap((metafile) => Object.entries(metafile.inputs))
    .sort(([, left], [, right]) => right.bytes - left.bytes)
    .slice(0, 8)
    .map(([path, input]) => `  ${formatBytes(input.bytes).padStart(9)}  ${path}`)
    .join("\n");
  const message = failures
    .map(
      ([name, budget]) =>
        `${name}: ${formatBytes(report.categories[name].raw)} exceeds ${formatBytes(budget)}`
    )
    .join("\n");
  throw new Error(`Gather Box artifact budget exceeded:\n${message}\nLargest source inputs:\n${largestInputs}`);
}

function formatBytes(bytes) {
  return bytes < 1_000_000 ? `${(bytes / 1_000).toFixed(1)} kB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
}
