import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { defaultBuildOptions, ensureLibmpv } from "../libmpv/build-libmpv.ts";
import { DEPLOYMENT_TARGET } from "../libmpv/sources.ts";

/**
 * Makes `apps/oriel-rs/target/release/bundle/Oriel RS.app` from a release build, for the owner to
 * double-click (plan 063):
 *
 *   pnpm --filter @latch-works/oriel-rs bundle
 *
 * - `Contents/MacOS/oriel-rs`: `cargo build --release -p oriel-rs`, in Cargo's own target folder
 *   (`CARGO_TARGET_DIR` if set);
 * - `Contents/Frameworks`: the LGPL libmpv set, built first if it is not (`build-libmpv.ts`);
 * - `Contents/Resources/media-tools`: the pinned ffmpeg and ffprobe, fetched first if they are
 *   not, where `oriel-tools` looks for them in a bundle;
 * - `Contents/Resources/licenses/libmpv`: the set's licences and manifest;
 * - Electron Oriel's icon, an `Info.plist`, and an ad hoc signature over the whole.
 *
 * The bundle carries no data: the app keeps everything in `~/.latch-works/oriel-rs`, as a
 * development build does.
 */

const WORKSPACE = path.resolve(import.meta.dirname, "..", "..");

const REPOSITORY = path.resolve(WORKSPACE, "..", "..");

const APP_NAME = "Oriel RS";

const BUNDLE_ID = "dev.traydr.latchworks.oriel-rs";

const EXECUTABLE = "oriel-rs";

const ICON_FILE = "oriel-rs.icns";

/** Electron Oriel's icon, the same artwork for the same app. */
const ICON_SOURCE = path.join(REPOSITORY, "apps", "oriel", "media", "oriel-icon.icns");

const MEDIA_TOOLS = path.join(WORKSPACE, ".media-tools", "darwin-arm64");

function log(message: string): void {
  console.log(message);
}

/** Runs a command in the workspace with its output on this terminal; a failure stops the script. */
function run(program: string, args: readonly string[]): void {
  log(`$ ${[program, ...args].join(" ")}`);
  execFileSync(program, args, { cwd: WORKSPACE, stdio: "inherit" });
}

/** The workspace's version, which every crate inherits, from `[workspace.package]`. */
async function crateVersion(): Promise<string> {
  const manifest = await readFile(path.join(WORKSPACE, "Cargo.toml"), "utf8");
  const version = manifest.match(/\[workspace\.package\][^[]*?\nversion = "([^"]+)"/)?.[1];

  if (version === undefined) {
    throw new Error("Cargo.toml's [workspace.package] has no version");
  }

  return version;
}

/** Where Cargo puts the release binary, honouring `CARGO_TARGET_DIR` as Cargo does. */
function releaseBinary(): string {
  const target = process.env.CARGO_TARGET_DIR;
  const folder = target === undefined || target === "" ? "target" : target;

  return path.resolve(WORKSPACE, folder, "release", EXECUTABLE);
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function infoPlist(version: string): string {
  const strings = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleDisplayName", APP_NAME],
    ["CFBundleName", APP_NAME],
    ["CFBundleExecutable", EXECUTABLE],
    ["CFBundleIdentifier", BUNDLE_ID],
    ["CFBundleIconFile", ICON_FILE],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", version],
    ["CFBundleVersion", version],
    // ImageIO decodes AVIF from macOS 13, and the libmpv set is built for 13 and later.
    ["LSMinimumSystemVersion", DEPLOYMENT_TARGET],
    // Oriel views and tidies an archive of photos and videos.
    ["LSApplicationCategoryType", "public.app-category.photography"],
  ];

  const entries = strings.map(
    ([key = "", value = ""]) =>
      `  <key>${escapeXml(key)}</key>\n  <string>${escapeXml(value)}</string>`,
  );

  entries.push("  <key>NSHighResolutionCapable</key>\n  <true/>");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function sizeOf(target: string): string {
  return execFileSync("/usr/bin/du", ["-sh", target], { encoding: "utf8" }).split("\t")[0] ?? "";
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Oriel RS is bundled on macOS arm64 only");
  }

  log("1. The LGPL libmpv set");
  const libmpv = await ensureLibmpv(defaultBuildOptions());

  log("\n2. The pinned ffmpeg and ffprobe");
  run("cargo", ["run", "--quiet", "-p", "oriel-tools", "--bin", "fetch-media-tools"]);

  log("\n3. The release build");
  run("cargo", ["build", "--release", "-p", "oriel-rs"]);
  const binary = releaseBinary();
  const version = await crateVersion();

  log("\n4. The bundle");
  const bundleFolder = path.join(WORKSPACE, "target", "release", "bundle");
  const app = path.join(bundleFolder, `${APP_NAME}.app`);
  const staging = path.join(bundleFolder, `.${APP_NAME}.app.staging`);
  const contents = path.join(staging, "Contents");
  const frameworks = path.join(contents, "Frameworks");
  const resources = path.join(contents, "Resources");
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(frameworks, { recursive: true });
  await mkdir(path.join(resources, "media-tools"), { recursive: true });

  await copyFile(binary, path.join(contents, "MacOS", EXECUTABLE));
  await chmod(path.join(contents, "MacOS", EXECUTABLE), 0o755);
  await writeFile(path.join(contents, "Info.plist"), infoPlist(version));
  await writeFile(path.join(contents, "PkgInfo"), "APPL????");
  await copyFile(ICON_SOURCE, path.join(resources, ICON_FILE));

  const dylibs = (await readdir(libmpv.folder)).filter((file) => file.endsWith(".dylib"));

  for (const file of dylibs) {
    await copyFile(path.join(libmpv.folder, file), path.join(frameworks, file));
  }

  const notices = path.join(resources, "licenses", "libmpv");
  await cp(path.join(libmpv.folder, "licenses"), notices, { recursive: true });
  await copyFile(path.join(libmpv.folder, "manifest.json"), path.join(notices, "manifest.json"));

  for (const tool of ["ffmpeg", "ffprobe"]) {
    const target = path.join(resources, "media-tools", tool);
    await copyFile(path.join(MEDIA_TOOLS, tool), target);
    await chmod(target, 0o755);
  }

  run("/usr/bin/plutil", ["-lint", path.join(contents, "Info.plist")]);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", staging]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging]);
  await rm(app, { recursive: true, force: true });
  await rename(staging, app);

  const parts = [
    ["the app", path.join(app, "Contents", "MacOS")],
    [`libmpv set (${dylibs.length} dylibs)`, path.join(app, "Contents", "Frameworks")],
    ["ffmpeg and ffprobe", path.join(app, "Contents", "Resources", "media-tools")],
  ];

  log(`\n${app}: ${sizeOf(app)}, version ${version}, macOS ${DEPLOYMENT_TARGET} and later`);

  for (const [label = "", folder = ""] of parts) {
    log(`  ${sizeOf(folder).padStart(6)}  ${label}`);
  }

  log(`\nOpen it with: open "${path.relative(process.cwd(), app)}"`);
}

await main();
