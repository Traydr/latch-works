import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, createReadStream, openSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import {
  DEPLOYMENT_TARGET,
  type PinnedArchive,
  RECIPE_REVISION,
  SOURCES,
  type Source,
} from "./sources.ts";

/**
 * Builds Oriel RS's LGPL libmpv for macOS arm64 from the pinned sources in `sources.ts`, and
 * installs it as one folder of dylibs that can sit in an app's `Contents/Frameworks`:
 *
 *   node apps/oriel-rs/scripts/libmpv/build-libmpv.ts [--jobs 12] [--work <dir>] [--keep-work]
 *
 * The set lands in `apps/oriel-rs/.libmpv/<id>/`, where the id names mpv's and FFmpeg's versions
 * and a hash of every pin and flag, and `apps/oriel-rs/.libmpv/current` points at the newest. Each
 * dylib is named `@rpath/<file>` and finds the others through `@loader_path`, links nothing but
 * the set and the system, and is signed ad hoc. `manifest.json` beside them records versions,
 * hashes, flags, licences and what the libraries said about themselves; `SHA256SUMS` lets a later
 * run, and the bundle script, check the files are still the ones built.
 *
 * Resumable: downloads are kept by hash, and each step of each source leaves a stamp, so an
 * interrupted run picks up at the step that did not finish. Only meson, ninja and pkgconf are
 * needed beyond Xcode; the builds see them, the system and nothing else on `PATH`, and pkg-config
 * sees only the set's own libraries, so nothing from Homebrew can be linked in.
 */

const WORKSPACE = path.resolve(import.meta.dirname, "..", "..");

/** `apps/oriel-rs/.libmpv`, git-ignored, holding one folder per built set. */
const LIBMPV_ROOT = path.join(WORKSPACE, ".libmpv");

/** Sources, builds and the staging prefix, under Cargo's target folder, which tools ignore. */
const DEFAULT_WORK = path.join(WORKSPACE, "target", "libmpv");

const LGPL = "LGPL version 2.1 or later";

const SYSTEM_PREFIXES = ["/usr/lib/", "/System/Library/"];

/** The set's own name for the library the player loads. */
const LIBMPV_FILE = "libmpv.2.dylib";

const CHECKSUMS_FILE = "SHA256SUMS";

/** How long one download may take before the next try. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface BuildOptions {
  jobs: number;
  work: string;
  keepWork: boolean;
}

/** A built set: its id and folder. */
interface LibmpvSet {
  id: string;
  folder: string;
}

/** Where one set's sources, builds and staging prefix live while it is built. */
interface WorkTree {
  root: string;
  downloads: string;
  src: string;
  build: string;
  prefix: string;
  logs: string;
  stamps: string;
  tools: string;
}

interface Command {
  label: string;
  program: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

/** What a Mach-O file's load commands say about it. */
interface MachO {
  id: string | null;
  links: string[];
  rpaths: string[];
  minos: string | null;
}

interface Library {
  file: string;
  source: string;
  licence: string;
  bytes: number;
  sha256: string;
  minos: string;
  links: string[];
}

function log(message: string): void {
  console.log(message);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);

  return hash.digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);

    return true;
  } catch {
    return false;
  }
}

function sourceDir(work: WorkTree, source: Source): string {
  return path.join(work.src, `${source.name}-${source.version}`);
}

function sourceByName(name: string): Source {
  const source = SOURCES.find((candidate) => candidate.name === name);

  if (source === undefined) {
    throw new Error(`sources.ts has no ${name}`);
  }

  return source;
}

/** The set's id: mpv's and FFmpeg's versions, and a hash of everything that shapes the build. */
function setId(): string {
  // Where a source is downloaded from does not change what is built; its hash does.
  const recipe = JSON.stringify({ RECIPE_REVISION, DEPLOYMENT_TARGET, SOURCES }, (key, value) =>
    key === "urls" ? undefined : value,
  );

  return [
    `mpv-${sourceByName("mpv").version}`,
    `ffmpeg-${sourceByName("ffmpeg").version}`,
    "lgpl",
    sha256Text(recipe).slice(0, 10),
  ].join("-");
}

function workTree(base: string, id: string): WorkTree {
  const root = path.join(base, id);

  return {
    root,
    downloads: path.join(base, "downloads"),
    src: path.join(root, "src"),
    build: path.join(root, "build"),
    prefix: path.join(root, "prefix"),
    logs: path.join(root, "logs"),
    stamps: path.join(root, "stamps"),
    tools: path.join(root, "tools"),
  };
}

/** Runs a step's command with its output in a log file, printing the log's end if it fails. */
async function run(command: Command): Promise<void> {
  const started = performance.now();
  await mkdir(path.dirname(command.log), { recursive: true });
  const descriptor = openSync(command.log, "a");

  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", descriptor, descriptor],
    });

    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => closeSync(descriptor));

  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  if (status !== 0) {
    const tail = (await readFile(command.log, "utf8")).split("\n").slice(-40).join("\n");
    console.error(tail);

    throw new Error(`${command.label} failed (exit ${status}); the full log is ${command.log}`);
  }

  log(`    ${command.label}: done in ${seconds} s`);
}

/** Output of a short command whose failure stops the build. */
function capture(program: string, args: readonly string[]): string {
  return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Runs `step` unless its stamp says it finished on an earlier run. */
async function stamped(work: WorkTree, step: string, body: () => Promise<void>): Promise<void> {
  const stamp = path.join(work.stamps, step);

  if (await exists(stamp)) {
    log(`    ${step}: done on an earlier run`);

    return;
  }

  await body();
  await mkdir(work.stamps, { recursive: true });
  await writeFile(stamp, `${new Date().toISOString()}\n`);
}

/**
 * The bytes at the first of `urls` that answers, trying each twice: some publishers' servers
 * (savannah, for FreeType) are often unreachable for a while. The largest archive is about
 * 20 MB, so it is held whole and hashed before it touches the disk.
 */
async function fetchFirst(urls: readonly string[]): Promise<Buffer> {
  const failures: string[] = [];

  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      log(`    downloading ${url}`);

      try {
        const response = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });

        if (response.ok) {
          return Buffer.from(await response.arrayBuffer());
        }

        failures.push(`${url}: HTTP ${response.status}`);
      } catch (error) {
        const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error);
        failures.push(`${url}: ${reason}`);
      }
    }
  }

  throw new Error(`could not download:\n  ${failures.join("\n  ")}`);
}

/** Downloads `archive` into the cache unless a file there already has its hash. */
async function download(work: WorkTree, archive: PinnedArchive): Promise<string> {
  const target = path.join(work.downloads, archive.file);

  if (await exists(target)) {
    if ((await sha256File(target)) === archive.sha256) {
      return target;
    }

    log(`    ${archive.file}: cached copy has another hash; downloading it again`);
    await rm(target);
  }

  await mkdir(work.downloads, { recursive: true });
  const bytes = await fetchFirst(archive.urls);
  const actual = createHash("sha256").update(bytes).digest("hex");

  if (actual !== archive.sha256) {
    throw new Error(
      `${archive.file} hashes to ${actual}, not the pinned ${archive.sha256}; refusing to use it`,
    );
  }

  const partial = `${target}.part`;
  await writeFile(partial, bytes);
  await rename(partial, target);

  return target;
}

/** An archive to unpack, the empty folder of its own it goes in, and the name its log has. */
interface Unpacking {
  archive: string;
  folder: string;
  label: string;
}

/** Unpacks an archive into an empty folder of its own. bsdtar refuses `..` and absolute paths. */
async function unpack(work: WorkTree, { archive, folder, label }: Unpacking): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await run({
    label: `unpack ${label}`,
    program: "/usr/bin/tar",
    args: ["-xf", archive, "-C", folder, "--strip-components=1"],
    cwd: folder,
    env: { PATH: "/usr/bin:/bin" },
    log: path.join(work.logs, `${label}-unpack.log`),
  });
}

/** Finds the first of `names` on the caller's `PATH`, as a shell would. */
function findOnPath(names: readonly string[]): string {
  for (const name of names) {
    for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(folder, name);

      try {
        accessSync(candidate, constants.X_OK);

        return candidate;
      } catch {
        // Not here; try the next folder.
      }
    }
  }

  throw new Error(`${names.join(" or ")} is not on PATH; see docs/runbooks/oriel-rs.md`);
}

/**
 * A folder holding only the build tools the builds may run beyond the system's, so the builds'
 * `PATH` need not include Homebrew's folder and whatever else it holds.
 */
async function linkTools(work: WorkTree): Promise<void> {
  const tools = [
    { link: "meson", target: findOnPath(["meson"]) },
    { link: "ninja", target: findOnPath(["ninja"]) },
    { link: "pkg-config", target: findOnPath(["pkgconf", "pkg-config"]) },
  ];

  await rm(work.tools, { recursive: true, force: true });
  await mkdir(work.tools, { recursive: true });

  for (const tool of tools) {
    await symlink(tool.target, path.join(work.tools, tool.link));
  }
}

/** The environment every build runs in, built from nothing rather than from the caller's. */
function buildEnv(work: WorkTree, sdk: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: os.homedir(),
    PATH: [work.tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
    SDKROOT: sdk,
    // Replaces pkg-config's search path: only the set's own libraries are found.
    PKG_CONFIG_LIBDIR: path.join(work.prefix, "lib", "pkgconfig"),
  };

  if (process.env.DEVELOPER_DIR !== undefined) {
    env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
  }

  return env;
}

async function buildSource(
  work: WorkTree,
  source: Source,
  env: NodeJS.ProcessEnv,
  jobs: number,
): Promise<void> {
  const label = `${source.name} ${source.version}`;
  log(`\n${label} (${source.licence})`);
  const src = sourceDir(work, source);
  const build = path.join(work.build, source.name);
  const logFile = (step: string) => path.join(work.logs, `${source.name}-${step}.log`);

  await stamped(work, `${source.name}.unpack`, async () => {
    const archive = await download(work, source.archive);
    await unpack(work, { archive, folder: src, label: source.name });

    for (const part of source.parts) {
      const archive = await download(work, part.archive);
      await unpack(work, {
        archive,
        folder: path.join(src, part.folder),
        label: `${source.name}-${part.name}`,
      });
    }
  });

  await stamped(work, `${source.name}.configure`, async () => {
    await rm(build, { recursive: true, force: true });
    await mkdir(build, { recursive: true });

    if (source.buildSystem === "meson") {
      await run({
        label: "meson setup",
        program: "meson",
        args: [
          "setup",
          build,
          src,
          `--prefix=${work.prefix}`,
          "--libdir=lib",
          "--buildtype=release",
          "--default-library=shared",
          "-Db_ndebug=true",
          // Never a subproject in place of a missing dependency, and never a download.
          "--wrap-mode=nofallback",
          ...source.options,
        ],
        cwd: build,
        env,
        log: logFile("configure"),
      });
    } else {
      await run({
        label: "configure",
        program: path.join(src, "configure"),
        args: [
          `--prefix=${work.prefix}`,
          "--install-name-dir=@rpath",
          "--pkg-config=pkg-config",
          ...source.options,
        ],
        cwd: build,
        env,
        log: logFile("configure"),
      });
    }
  });

  await stamped(work, `${source.name}.build`, async () => {
    const meson = source.buildSystem === "meson";
    await run({
      label: "build",
      program: meson ? "ninja" : "make",
      args: meson ? ["-C", build, `-j${jobs}`] : [`-j${jobs}`],
      cwd: build,
      env,
      log: logFile("build"),
    });
  });

  await stamped(work, `${source.name}.install`, async () => {
    const meson = source.buildSystem === "meson";
    await run({
      label: "install",
      program: meson ? "meson" : "make",
      args: meson ? ["install", "-C", build, "--no-rebuild"] : ["install"],
      cwd: build,
      env,
      log: logFile("install"),
    });
  });
}

/** Reads the install name, linked libraries, rpaths and minimum macOS from `otool -l`. */
function readMachO(file: string): MachO {
  const machO: MachO = { id: null, links: [], rpaths: [], minos: null };
  let command = "";

  for (const line of capture("/usr/bin/otool", ["-l", file]).split("\n")) {
    const field = line.trim().match(/^(\S+) (.*)$/);

    if (field === null) {
      continue;
    }

    const [, key, rest = ""] = field;
    const value = rest.replace(/ \(offset \d+\)$/, "");

    if (key === "cmd") {
      command = value;
    } else if (key === "name" && command === "LC_ID_DYLIB") {
      machO.id = value;
    } else if (key === "name" && command.startsWith("LC_") && command.includes("DYLIB")) {
      machO.links.push(value);
    } else if (key === "path" && command === "LC_RPATH") {
      machO.rpaths.push(value);
    } else if (key === "minos" && command === "LC_BUILD_VERSION") {
      machO.minos = value;
    }
  }

  return machO;
}

function isSystem(link: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => link.startsWith(prefix));
}

/** The set's file a link names, or null for a system library; anything else stops the build. */
function memberOf(work: WorkTree, link: string): string | null {
  if (isSystem(link)) {
    return null;
  }

  if (link.startsWith("@rpath/") || link.startsWith(`${work.prefix}/`)) {
    return path.basename(link);
  }

  throw new Error(`a library links ${link}, which is neither the set's nor the system's`);
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/** The source that makes each library, by the file name's stem. */
const LIBRARY_SOURCES = new Map([
  ["libmpv", "mpv"],
  ["libplacebo", "libplacebo"],
  ["libass", "libass"],
  ["libfreetype", "freetype"],
  ["libfribidi", "fribidi"],
  ["libharfbuzz", "harfbuzz"],
  ["libdav1d", "dav1d"],
  ["libavcodec", "ffmpeg"],
  ["libavformat", "ffmpeg"],
  ["libavutil", "ffmpeg"],
  ["libavfilter", "ffmpeg"],
  ["libswscale", "ffmpeg"],
  ["libswresample", "ffmpeg"],
]);

/** Which source built a library file. */
function sourceOfLibrary(file: string): Source {
  const owner = LIBRARY_SOURCES.get(file.split(".")[0] ?? file);

  if (owner === undefined) {
    throw new Error(`no source in sources.ts is known to make ${file}`);
  }

  return sourceByName(owner);
}

/**
 * Copies libmpv and every library it needs from the staging prefix into `out`, names each
 * `@rpath/<file>` with `@loader_path` as its only rpath, strips local symbols and signs ad hoc.
 */
async function assemble(work: WorkTree, out: string): Promise<Library[]> {
  const lib = path.join(work.prefix, "lib");
  const members: string[] = [];
  const queue = [LIBMPV_FILE];

  while (queue.length > 0) {
    const file = queue.shift() ?? "";

    if (members.includes(file)) {
      continue;
    }

    members.push(file);

    for (const link of readMachO(path.join(lib, file)).links) {
      const member = memberOf(work, link);

      if (member !== null && member !== file) {
        queue.push(member);
      }
    }
  }

  log(`\nAssembling ${members.length} libraries into ${out}`);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  for (const file of members) {
    const target = path.join(out, file);
    await copyFile(await realpath(path.join(lib, file)), target);
    await chmod(target, 0o755);
    capture("/usr/bin/strip", ["-x", target]);
    const machO = readMachO(target);
    const args = ["-id", `@rpath/${file}`];

    for (const link of machO.links) {
      const member = memberOf(work, link);

      if (member !== null && link !== `@rpath/${member}`) {
        args.push("-change", link, `@rpath/${member}`);
      }
    }

    // The builds leave rpaths to their own folders and Xcode's Swift libraries; the set needs
    // only its own folder, wherever it is copied.
    for (const rpath of machO.rpaths.filter((rpath) => rpath !== "@loader_path")) {
      args.push("-delete_rpath", rpath);
    }

    if (!machO.rpaths.includes("@loader_path")) {
      args.push("-add_rpath", "@loader_path");
    }

    args.push(target);
    capture("/usr/bin/install_name_tool", args);
    capture("/usr/bin/codesign", ["--force", "--sign", "-", target]);
  }

  const libraries: Library[] = [];

  for (const file of members) {
    const target = path.join(out, file);
    const machO = readMachO(target);
    const problems: string[] = [];

    if (machO.id !== `@rpath/${file}`) {
      problems.push(`its install name is ${machO.id}`);
    }

    for (const link of machO.links) {
      if (!isSystem(link) && !members.some((member) => link === `@rpath/${member}`)) {
        problems.push(`it links ${link}`);
      }
    }

    if (machO.rpaths.join(" ") !== "@loader_path") {
      problems.push(`its rpaths are ${machO.rpaths.join(", ")}`);
    }

    if (machO.minos === null || compareVersions(machO.minos, DEPLOYMENT_TARGET) > 0) {
      problems.push(`it needs macOS ${machO.minos}, above ${DEPLOYMENT_TARGET}`);
    }

    if (problems.length > 0) {
      throw new Error(`${file} is not fit for the set: ${problems.join("; ")}`);
    }

    const source = sourceOfLibrary(file);
    libraries.push({
      file,
      source: source.name,
      licence: source.licence,
      bytes: (await stat(target)).size,
      sha256: await sha256File(target),
      minos: machO.minos ?? "",
      links: machO.links.filter((link) => link !== `@rpath/${file}`),
    });
  }

  return libraries;
}

/** What `check-libmpv.c` reports, by key. */
type Report = Map<string, string>;

/** One thing the set must say about itself. */
interface Expectation {
  key: string;
  holds: (value: string) => boolean;
  wanted: string;
}

/** Builds and runs `check-libmpv.c` against the assembled set, and refuses a set that is not LGPL. */
async function checkSet(work: WorkTree, out: string, env: NodeJS.ProcessEnv): Promise<Report> {
  log("\nChecking what the set says about itself");
  const program = path.join(work.root, "check-libmpv");
  const linked = (await readdir(out)).filter((file) => file.endsWith(".dylib")).toSorted();
  await run({
    label: "compile check-libmpv.c",
    program: "/usr/bin/clang",
    args: [
      path.join(import.meta.dirname, "check-libmpv.c"),
      "-o",
      program,
      `-I${path.join(work.prefix, "include")}`,
      ...linked.map((file) => path.join(out, file)),
      `-Wl,-rpath,${out}`,
    ],
    cwd: work.root,
    env,
    log: path.join(work.logs, "check-compile.log"),
  });
  const report: Report = new Map();

  for (const line of capture(program, []).split("\n")) {
    const tab = line.indexOf("\t");

    if (tab > 0) {
      report.set(line.slice(0, tab), line.slice(tab + 1));
    }
  }

  const features = (report.get("mpv_features") ?? "").split(" ");

  const expectations: Expectation[] = [
    ...["avutil", "avcodec", "avformat", "avfilter", "swscale", "swresample"].map((library) => ({
      key: `${library}_license`,
      holds: (value: string) => value === LGPL,
      wanted: LGPL,
    })),
    {
      key: "ffmpeg_configuration",
      holds: (value) => !/--enable-(gpl|nonfree|version3)\b/.test(value),
      wanted: "no --enable-gpl, --enable-nonfree or --enable-version3",
    },
    {
      key: "mpv_client_api_version",
      holds: (value) => value === "2.5",
      wanted: "2.5, the API the player's FFI follows",
    },
    {
      key: "mpv-configuration",
      holds: (value) => value.includes("-Dgpl=false"),
      wanted: "-Dgpl=false",
    },
    {
      key: "mpv_features",
      holds: () => !features.includes("gpl") && features.includes("videotoolbox-gl"),
      wanted: "videotoolbox-gl and not gpl",
    },
    ...["h264", "hevc", "av1", "vp9"].map((codec) => ({
      key: `decoder.${codec}`,
      holds: (value: string) => value === "videotoolbox",
      wanted: "decoding through VideoToolbox",
    })),
    {
      key: "decoder.libdav1d",
      holds: (value) => value === "software",
      wanted: "dav1d, for AV1 in software",
    },
    ...[...report.keys()].flatMap((key) =>
      key.startsWith("demuxer.")
        ? [{ key, holds: (value: string) => value === "present", wanted: "present" }]
        : [],
    ),
    {
      key: "encoder.h264",
      holds: (value) => value === "missing",
      wanted: "missing: a player's set has no encoders",
    },
  ];

  const failures = expectations.flatMap((expectation) => {
    const value = report.get(expectation.key) ?? "(missing)";

    return expectation.holds(value)
      ? []
      : [`${expectation.key} is "${value}", expected ${expectation.wanted}`];
  });

  if (failures.length > 0) {
    throw new Error(`the set failed its checks:\n  ${failures.join("\n  ")}`);
  }

  for (const key of [
    "avcodec_license",
    "mpv_client_api_version",
    "mpv-version",
    "ffmpeg-version",
  ]) {
    log(`    ${key}: ${report.get(key)}`);
  }

  log(`    mpv features: ${report.get("mpv_features")}`);

  return report;
}

/** Copies each shipped source's licence files into `out/licenses/<source>/`. */
async function copyLicences(work: WorkTree, out: string): Promise<void> {
  for (const source of SOURCES) {
    const from = sourceDir(work, source);
    const parts = source.parts.filter((part) => part.ships);

    const entries = [
      ...source.licenceFiles.map((file) => ({ name: source.name, file: path.join(from, file) })),
      ...parts.flatMap((part) =>
        part.licenceFiles.map((file) => ({
          name: `${source.name}-${part.name}`,
          file: path.join(from, part.folder, file),
        })),
      ),
    ];

    for (const entry of entries) {
      const folder = path.join(out, "licenses", entry.name);
      await mkdir(folder, { recursive: true });
      await copyFile(entry.file, path.join(folder, path.basename(entry.file)));
    }
  }
}

function toolchain(): Map<string, string> {
  const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";

  return new Map([
    ["clang", firstLine(capture("/usr/bin/clang", ["--version"]))],
    ["swiftc", firstLine(capture("/usr/bin/xcrun", ["swiftc", "--version"]))],
    ["sdk", firstLine(capture("/usr/bin/xcrun", ["--show-sdk-version"]))],
    ["meson", firstLine(capture(findOnPath(["meson"]), ["--version"]))],
    ["ninja", firstLine(capture(findOnPath(["ninja"]), ["--version"]))],
    ["pkgconf", firstLine(capture(findOnPath(["pkgconf", "pkg-config"]), ["--version"]))],
  ]);
}

/** An array of plain values that `JSON.stringify` spread over lines, with what came before it. */
const SPREAD_ARRAY =
  /^( *)([^\n]*)\[\n((?: *(?:"(?:[^"\\\n]|\\.)*"|-?[\d.eE+-]+|true|false|null),?\n)+) *\](,?)$/gm;

/**
 * `JSON.stringify`'s two-space layout with each array of plain values on one line when it fits
 * in 100 columns, which is how the repository's Biome lays JSON out. Biome checks git-ignored
 * folders too, so the manifest must already be formatted for `pnpm lint:all` to pass.
 */
function formatJson(text: string): string {
  const collapsed = text.replace(
    SPREAD_ARRAY,
    (spread: string, indent: string, head: string, body: string, comma: string) => {
      const items = body.split("\n").flatMap((item) => {
        const value = item.trim().replace(/,$/, "");

        return value.length > 0 ? [value] : [];
      });

      const line = `${indent}${head}[${items.join(", ")}]${comma}`;

      return line.length <= 100 ? line : spread;
    },
  );

  return `${collapsed}\n`;
}

async function writeManifest(
  set: LibmpvSet,
  libraries: readonly Library[],
  report: Report,
  seconds: number,
): Promise<void> {
  const manifest = {
    id: set.id,
    builtAt: new Date().toISOString(),
    runSeconds: Math.round(seconds),
    platform: "darwin-arm64",
    deploymentTarget: DEPLOYMENT_TARGET,
    licence:
      "LGPL-2.1-or-later as a whole: mpv, FFmpeg, libplacebo and FriBidi are LGPL; libass, " +
      "FreeType, HarfBuzz and dav1d are permissive. Sources and flags are below.",
    toolchain: Object.fromEntries(toolchain()),
    totalBytes: libraries.reduce((total, library) => total + library.bytes, 0),
    libraries,
    sources: SOURCES.map((source) => ({
      name: source.name,
      version: source.version,
      urls: source.archive.urls,
      sha256: source.archive.sha256,
      hashCheckedAgainst: source.hashCheckedAgainst,
      licence: source.licence,
      buildSystem: source.buildSystem,
      options: source.options,
      parts: source.parts.map((part) => ({
        name: part.name,
        folder: part.folder,
        urls: part.archive.urls,
        sha256: part.archive.sha256,
        licence: part.licence,
        ships: part.ships,
      })),
    })),
    reported: Object.fromEntries(report),
  };

  await writeFile(
    path.join(set.folder, "manifest.json"),
    formatJson(JSON.stringify(manifest, null, 2)),
  );
  const sums = libraries.map((library) => `${library.sha256}  ${library.file}\n`).join("");
  await writeFile(path.join(set.folder, CHECKSUMS_FILE), sums);
}

/** Whether `folder` holds a whole set whose files still hash to what was recorded. */
async function isIntact(folder: string): Promise<boolean> {
  if (!(await exists(path.join(folder, "manifest.json")))) {
    return false;
  }

  let sums: string;

  try {
    sums = await readFile(path.join(folder, CHECKSUMS_FILE), "utf8");
  } catch {
    return false;
  }

  const lines = sums.split("\n").filter((line) => line.length > 0);

  for (const line of lines) {
    const entry = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);

    if (entry === null) {
      return false;
    }

    const [, sha256, file = ""] = entry;
    const target = path.join(folder, file);

    if (!(await exists(target)) || (await sha256File(target)) !== sha256) {
      return false;
    }
  }

  return lines.some((line) => line.endsWith(`  ${LIBMPV_FILE}`));
}

/** Points `.libmpv/current` at `id`, replacing the link in one rename. */
async function pointCurrentAt(id: string): Promise<void> {
  const current = path.join(LIBMPV_ROOT, "current");
  const next = `${current}.next`;
  await rm(next, { force: true });
  await symlink(id, next);
  await rename(next, current);
}

async function folderBytes(folder: string): Promise<number> {
  let total = 0;

  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      total += (await stat(path.join(entry.parentPath, entry.name))).size;
    }
  }

  return total;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * Makes sure the pinned set is built and intact, building it when it is not, and returns it.
 * The bundle script calls this; it is quick once the set exists.
 */
export async function ensureLibmpv(options: BuildOptions): Promise<LibmpvSet> {
  const id = setId();
  const folder = path.join(LIBMPV_ROOT, id);

  if (await isIntact(folder)) {
    log(`The LGPL libmpv set ${id} is built: ${folder}`);
    await pointCurrentAt(id);

    return { id, folder };
  }

  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("the LGPL libmpv set is built on macOS arm64 only");
  }

  const started = performance.now();
  const work = workTree(options.work, id);
  log(`Building the LGPL libmpv set ${id}`);
  log(`  work tree: ${work.root} (resumable; safe to delete once the set is built)`);
  log(`  jobs: ${options.jobs}, macOS ${DEPLOYMENT_TARGET} and later`);
  await mkdir(work.root, { recursive: true });
  await linkTools(work);
  const sdk = capture("/usr/bin/xcrun", ["--show-sdk-path"]).trim();
  const env = buildEnv(work, sdk);

  for (const source of SOURCES) {
    await buildSource(work, source, env, options.jobs);
  }

  const partial = `${folder}.partial`;
  const libraries = await assemble(work, partial);
  const report = await checkSet(work, partial, env);
  await copyLicences(work, partial);
  const seconds = (performance.now() - started) / 1000;
  await writeManifest({ id, folder: partial }, libraries, report, seconds);
  await rm(folder, { recursive: true, force: true });
  await rename(partial, folder);
  await pointCurrentAt(id);

  log(`\nThe LGPL libmpv set ${id} is built in ${Math.round(seconds)} s: ${folder}`);

  for (const library of libraries) {
    log(`  ${library.file.padEnd(28)} ${megabytes(library.bytes).padStart(9)}  ${library.licence}`);
  }

  log(`  total ${megabytes(await folderBytes(folder))}, licences and manifest included`);

  if (options.keepWork) {
    log(`  the work tree stays in ${work.root}`);
  } else {
    await rm(work.root, { recursive: true, force: true });
    log(`  removed the work tree; the downloads stay in ${work.downloads}`);
  }

  return { id, folder };
}

/** The defaults the command line and the bundle script share. */
export function defaultBuildOptions(): BuildOptions {
  return { jobs: os.availableParallelism(), work: DEFAULT_WORK, keepWork: false };
}

async function main(): Promise<void> {
  const defaults = defaultBuildOptions();

  const { values } = parseArgs({
    options: {
      jobs: { type: "string", default: String(defaults.jobs) },
      work: { type: "string", default: defaults.work },
      "keep-work": { type: "boolean", default: false },
    },
  });

  await ensureLibmpv({
    jobs: Math.max(1, Number.parseInt(values.jobs, 10) || 1),
    work: path.resolve(values.work),
    keepWork: values["keep-work"],
  });
}

if (import.meta.main) {
  await main();
}
