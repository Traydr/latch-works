import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";
import {
  AVIF_CODEC_PATH,
  AVIF_WORKER_PATH,
  COMMANDS,
  collectorScriptPath,
  OFFSCREEN_DOCUMENT_PATH,
  OPTIONS_PAGE_PATH,
  STORY_FONT_PATHS,
} from "../src/shared/constants.ts";
import {
  findCatalogProblems,
  GATHER_SOURCES,
  getPageMatches,
} from "../src/shared/source-catalog.ts";

const root = resolve(import.meta.dirname, "..");

const dist = resolve(root, "dist");

const reports = resolve(root, ".build-meta");

const development = process.env.NODE_ENV === "development";

const bundlerWarnings = [];

const manifestBase = JSON.parse(await readFile(resolve(root, "manifest.base.json"), "utf8"));

const input = {
  cwd: root,
  platform: "browser",
  // Workspace packages resolve through their `source` export, so the build never reads a stale
  // or missing `dist/`. The rest are Rolldown's browser defaults for an import.
  resolve: { conditionNames: ["source", "import", "browser", "default"] },
  transform: { target: `chrome${manifestBase.minimum_chrome_version}` },
  onLog: (level, log) => {
    if (level === "warn") bundlerWarnings.push(`${log.code ?? "WARNING"}: ${log.message}`);
  },
};

const output = {
  dir: dist,
  entryFileNames: "[name].js",
  minify: !development,
  sourcemap: development ? "inline" : false,
};

const netRequestRules = GATHER_SOURCES.flatMap((source) => source.netRequestRules ?? []).sort(
  (left, right) => left.id.localeCompare(right.id),
);

const packagedFiles = [
  "ui/gather-box.css",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.css",
  OPTIONS_PAGE_PATH,
  "options/options.css",
  OFFSCREEN_DOCUMENT_PATH,
  ...netRequestRules.map((rule) => rule.path),
  ...Object.values(STORY_FONT_PATHS),
  "assets/fonts/OFL.txt",
  "assets/icons/icon16.png",
  "assets/icons/icon32.png",
  "assets/icons/icon48.png",
  "assets/icons/icon128.png",
];

/**
 * Each collector's content script is generated: it installs the collector module the catalog key
 * names, so a source's key, collector and script path cannot drift apart.
 */
const COLLECTOR_ENTRY_PREFIX = "gather-box-collector:";

const collectorEntries = {
  name: "gather-box-collector-entries",
  resolveId: (id) => (id.startsWith(COLLECTOR_ENTRY_PREFIX) ? `\0${id}` : null),
  load: (id) => {
    if (!id.startsWith(`\0${COLLECTOR_ENTRY_PREFIX}`)) return null;

    const key = id.slice(COLLECTOR_ENTRY_PREFIX.length + 1);

    return [
      `import { installCollector } from ${JSON.stringify(resolve(root, "src/content/collector-entry.ts"))};`,
      `import { collect } from ${JSON.stringify(resolve(root, collectorModulePath(key)))};`,
      `installCollector(${JSON.stringify(key)}, collect);`,
    ].join("\n");
  },
};

await verifyVersionAgreement();

const { manifest, permissionReport } = await generateManifest();

await rm(dist, { force: true, recursive: true });

await rm(reports, { force: true, recursive: true });

await mkdir(dist, { recursive: true });

await Promise.all(packagedFiles.map(copyPackagedFile));

await mkdir(resolve(dist, "codecs"), { recursive: true });

await copyFile(
  resolve(root, "node_modules/@jsquash/avif/codec/enc/avif_enc.wasm"),
  resolve(dist, AVIF_CODEC_PATH),
);

await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const pages = await bundle(
  {
    "sidepanel/sidepanel": "src/sidepanel/index.ts",
    "options/options": "src/options/index.ts",
    "offscreen/offscreen": "src/offscreen/index.ts",
    [AVIF_WORKER_PATH.replace(/\.js$/, "")]: "src/shared/media/avif-encoder.worker.ts",
  },
  { chunkFileNames: "chunks/[name]-[hash].js", format: "esm" },
);

const background = await bundle(
  { "background/service-worker": "src/background/index.ts" },
  { codeSplitting: false, format: "esm" },
);

// Rolldown rejects IIFE output for more than one entry, so every content script is its own build.
const content = (
  await Promise.all(
    [
      ["content/page-shortcuts", "src/content/page-shortcuts-entry.ts"],
      ...GATHER_SOURCES.map((source) => [
        collectorScriptPath(source.key).replace(/\.js$/, ""),
        `${COLLECTOR_ENTRY_PREFIX}${source.key}`,
      ]),
    ].map(([name, entry]) =>
      bundle({ [name]: entry }, { codeSplitting: false, format: "iife" }, [collectorEntries]),
    ),
  )
).flat();

if (bundlerWarnings.length > 0) {
  throw new Error(`Rolldown reported warnings:\n${[...new Set(bundlerWarnings)].join("\n")}`);
}

const metafiles = {
  pages: describeChunks(pages),
  background: describeChunks(background),
  content: describeChunks(content),
};

await mkdir(reports, { recursive: true });

await writeFile(
  resolve(reports, "permissions.json"),
  `${JSON.stringify(permissionReport, null, 2)}\n`,
);

await Promise.all(
  Object.entries(metafiles).map(([name, metafile]) =>
    writeFile(resolve(reports, `${name}.json`), `${JSON.stringify(metafile, null, 2)}\n`),
  ),
);

const report = await createArtifactReport(metafiles);

await writeFile(resolve(reports, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);

// Development output is unminified and carries inline sourcemaps, so the budgets only fit a release.
if (!development) enforceBudgets(report, metafiles);

for (const [name, measurement] of Object.entries(report.categories)) {
  process.stdout.write(
    `${name.padEnd(24)} ${formatBytes(measurement.raw).padStart(9)} raw  ${formatBytes(measurement.gzip).padStart(9)} gzip\n`,
  );
}

async function bundle(entries, format, plugins = []) {
  const build = await rolldown({ ...input, input: entries, plugins });

  try {
    const written = await build.write({ ...output, ...format });

    return written.output.filter((file) => file.type === "chunk");
  } finally {
    await build.close();
  }
}

/**
 * This script's own build report, which the isolation and budget checks read: outputs keyed by
 * `dist/` path with their imports and source inputs. Paths use forward slashes on every platform.
 * Static and dynamic imports both count.
 */
function describeChunks(chunks) {
  const sources = (chunk) =>
    Object.entries(chunk.modules).flatMap(([id, module]) =>
      id.startsWith("\0") ? [] : [[relative(root, id).split(sep).join("/"), module.renderedLength]],
    );

  return {
    inputs: Object.fromEntries(
      chunks.flatMap((chunk) => sources(chunk).map(([path, bytes]) => [path, { bytes }])),
    ),
    outputs: Object.fromEntries(
      chunks.map((chunk) => [
        `dist/${chunk.fileName}`,
        {
          bytes: Buffer.byteLength(chunk.code),
          isEntry: chunk.isEntry,
          imports: [...chunk.imports, ...chunk.dynamicImports].map((path) => ({
            path: `dist/${path}`,
          })),
          inputs: Object.fromEntries(
            sources(chunk).map(([path, bytesInOutput]) => [path, { bytesInOutput }]),
          ),
        },
      ]),
    ),
  };
}

async function copyPackagedFile(relativePath) {
  const target = resolve(dist, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, relativePath), target);
}

async function verifyVersionAgreement() {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  if (packageJson.version !== manifestBase.version) {
    throw new Error(
      `Gather Box version mismatch: package.json=${packageJson.version}, manifest.json=${manifestBase.version}`,
    );
  }

  const declared = Object.keys(manifestBase.commands).sort().join(", ");
  const handled = Object.values(COMMANDS).sort().join(", ");

  if (declared !== handled) {
    throw new Error(
      `Gather Box commands drifted: manifest declares ${declared}, code handles ${handled}`,
    );
  }
}

function collectorModulePath(siteKey) {
  return `src/content/collectors/${siteKey}.ts`;
}

async function generateManifest() {
  const problems = findCatalogProblems();
  const permissionOwners = new Map();

  for (const source of GATHER_SOURCES) {
    for (const permission of source.hostPermissions) {
      const owners = permissionOwners.get(permission.pattern) ?? [];
      owners.push({ source: source.key, reason: permission.reason });
      permissionOwners.set(permission.pattern, owners);
    }

    await access(resolve(root, collectorModulePath(source.key))).catch(() => {
      problems.push(
        `Gather Source ${source.key} has no collector at ${collectorModulePath(source.key)}.`,
      );
    });
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  const hostPermissions = [...permissionOwners.keys()].sort();

  const permissionReport = hostPermissions.map((pattern) => ({
    pattern,
    owners: permissionOwners.get(pattern),
  }));

  return {
    manifest: {
      ...manifestBase,
      declarative_net_request: {
        rule_resources: netRequestRules.map((rule) => ({
          id: rule.id,
          enabled: true,
          path: rule.path,
        })),
      },
      host_permissions: hostPermissions,
      content_scripts: [
        {
          matches: getPageMatches(),
          js: ["content/page-shortcuts.js"],
          run_at: "document_start",
        },
      ],
    },
    permissionReport,
  };
}

async function createArtifactReport(metafiles) {
  const pageEntry = findOutput(metafiles.pages, "sidepanel/sidepanel.js");
  const offscreenEntry = findOutput(metafiles.pages, "offscreen/offscreen.js");

  const storyChunk = Object.entries(metafiles.pages.outputs).find(([, output]) =>
    Object.keys(output.inputs).some((input) => input.endsWith("src/offscreen/generated-story.ts")),
  )?.[0];

  if (!storyChunk) {
    throw new Error("Generated-story chunk was not emitted as an isolated local module.");
  }

  const mediaConversionChunk = Object.entries(metafiles.pages.outputs).find(([, output]) =>
    Object.keys(output.inputs).some((input) =>
      input.endsWith("src/shared/media/archive-media-transformer.ts"),
    ),
  )?.[0];

  if (!mediaConversionChunk) {
    throw new Error("Media-conversion chunk was not emitted as an isolated local module.");
  }

  const avifWorkerEntry = findOutput(metafiles.pages, AVIF_WORKER_PATH);

  const mediaConversionOutputs = getOutputGraph(metafiles.pages, [
    mediaConversionChunk,
    avifWorkerEntry,
  ]);

  const mediaConversionJs = await measureFiles(
    [...mediaConversionOutputs].flatMap((path) => (path.endsWith(".js") ? [outputPath(path)] : [])),
  );

  const mediaConversionWasm = await measureFiles([resolve(dist, AVIF_CODEC_PATH)]);

  verifyContentIsolation(metafiles.content);

  const collectorMeasurements = Object.fromEntries(
    await Promise.all(
      GATHER_SOURCES.map(async (source) => [
        `collector ${source.key} JS`,
        await measureOutputGraph(
          metafiles.content,
          findOutput(metafiles.content, collectorScriptPath(source.key)),
        ),
      ]),
    ),
  );

  const categories = {
    // The side panel loads the media conversion only to convert a file you hand back.
    "side panel eager JS": await measureOutputGraph(
      metafiles.pages,
      pageEntry,
      new Set([mediaConversionChunk]),
    ),
    "offscreen base JS": await measureOutputGraph(
      metafiles.pages,
      offscreenEntry,
      new Set([storyChunk, mediaConversionChunk]),
    ),
    "generated-story JS": await measureOutputGraph(
      metafiles.pages,
      storyChunk,
      new Set([mediaConversionChunk]),
    ),
    "media conversion JS": mediaConversionJs,
    "media conversion WASM": mediaConversionWasm,
    "media conversion assets": sumMeasurements(mediaConversionJs, mediaConversionWasm),
    "service worker JS": await measureOutputGraph(
      metafiles.background,
      findOutput(metafiles.background, "background/service-worker.js"),
    ),
    "page shortcuts JS": await measureOutputGraph(
      metafiles.content,
      findOutput(metafiles.content, "content/page-shortcuts.js"),
    ),
    ...collectorMeasurements,
    fonts: await measureDirectory(resolve(dist, "assets/fonts"), (name) => name.endsWith(".ttf")),
    icons: await measureDirectory(resolve(dist, "assets/icons"), () => true),
    "total JS": await measureJsOutputs(metafiles),
    "total dist": await measureDirectory(dist, () => true),
  };

  return {
    schemaVersion: 1,
    mode: development ? "development" : "release",
    storyChunk: storyChunk.replace(/^dist\//, ""),
    mediaConversionChunks: [...mediaConversionOutputs].map((path) => path.replace(/^dist\//, "")),
    categories,
  };
}

function verifyContentIsolation(metafile) {
  const shortcutOutput = metafile.outputs[findOutput(metafile, "content/page-shortcuts.js")];
  const shortcutInputs = Object.keys(shortcutOutput.inputs);

  if (shortcutInputs.some((input) => input.includes("/collectors/"))) {
    throw new Error("The always-on page-shortcut entry imports Gather Source collector code.");
  }

  for (const source of GATHER_SOURCES) {
    const output = metafile.outputs[findOutput(metafile, collectorScriptPath(source.key))];

    const collectorInputs = Object.keys(output.inputs).filter((input) =>
      input.includes("/collectors/"),
    );

    const expected = collectorModulePath(source.key);

    if (collectorInputs.length !== 1 || collectorInputs[0] !== expected) {
      throw new Error(
        `Collector entry ${source.key} crossed source seams: ${collectorInputs.join(", ") || "none"}`,
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

    // Rolldown keeps code that a page shares with its lazy chunks in the page entry, so a lazy
    // chunk imports that entry back. The page has already loaded it, so it is not the chunk's cost.
    if (metafile.outputs[path]?.isEntry && !entries.includes(path)) return;

    paths.add(path);

    for (const imported of metafile.outputs[path]?.imports ?? []) {
      if (metafile.outputs[imported.path]) visit(imported.path);
    }
  };

  for (const entry of entries) visit(entry);

  return paths;
}

async function measureJsOutputs(metafiles) {
  const outputs = new Set(
    Object.values(metafiles).flatMap((metafile) =>
      Object.keys(metafile.outputs).filter((path) => path.endsWith(".js")),
    ),
  );

  return measureFiles([...outputs].map(outputPath));
}

function outputPath(path) {
  return resolve(root, path);
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
      gzip: total.gzip + measurement.gzip,
    }),
    { raw: 0, gzip: 0 },
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
      }),
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
    "total dist": 8_000_000,
  };

  // Collectors parse their page and message inputs with zod/mini, which sets a ~35 kB floor.
  for (const source of GATHER_SOURCES) budgets[`collector ${source.key} JS`] = 48_000;

  const failures = Object.entries(budgets).filter(
    ([name, budget]) => report.categories[name].raw > budget,
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
        `${name}: ${formatBytes(report.categories[name].raw)} exceeds ${formatBytes(budget)}`,
    )
    .join("\n");

  throw new Error(
    `Gather Box artifact budget exceeded:\n${message}\nLargest source inputs:\n${largestInputs}`,
  );
}

function formatBytes(bytes) {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} kB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`;
}
