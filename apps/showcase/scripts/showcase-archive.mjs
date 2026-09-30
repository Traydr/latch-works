import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The throwaway sample archive the screenshot scripts generate and sync. It is deliberately not
 * configurable through LOCKSTEP_SOURCE: that variable names a real archive, and the scripts
 * write sample files into this directory.
 */
export const showcaseArchiveDir = "/tmp/showcase-archive";

/**
 * Written with a fresh random token, only into a directory the scripts have just created. Its
 * presence is what marks the directory as theirs; matching file names alone prove nothing.
 */
const ownerMarkerName = ".showcase-archive-owner";

const ownerMarkerPattern =
  /^latch-works showcase archive [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/;

const allowedDirectories = new Set(["sfw", "sfw/photos", "sfw/scans"]);

const generatedFilePatterns = [/^sfw\/photos\/sample-\d{2}\.jpg$/, /^sfw\/scans\/scan-\d{2}\.jpg$/];

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function refuse(dir, reason) {
  return new Error(
    `${dir} ${reason}. Refusing to write sample media into what may be a real archive; move it ` +
      "aside or delete it, then run prepare-showcase-media.mjs to create a fresh one.",
  );
}

/**
 * Creates the showcase archive and marks it as owned when it does not exist yet, then checks
 * ownership. An existing directory is never adopted: it must already carry the marker.
 */
export function claimShowcaseArchive(dir = showcaseArchiveDir) {
  if (lstatOrNull(dir) === null) {
    mkdirSync(dir);
    writeFileSync(join(dir, ownerMarkerName), `latch-works showcase archive ${randomUUID()}\n`, {
      flag: "wx",
    });
  }

  assertShowcaseArchive(dir);
}

/**
 * Throws unless `dir` is a real directory the showcase scripts created (it carries the owner
 * marker) and every entry under it is one the generators create, so a script can never write
 * sample files into a real archive.
 */
export function assertShowcaseArchive(dir = showcaseArchiveDir) {
  const stats = lstatOrNull(dir);

  if (stats === null) {
    throw new Error(`Showcase archive missing at ${dir}; run prepare-showcase-media.mjs`);
  }

  if (!stats.isDirectory()) {
    throw refuse(dir, "is not a plain directory (it may be a symbolic link)");
  }

  const markerPath = join(dir, ownerMarkerName);
  const markerStats = lstatOrNull(markerPath);

  if (
    markerStats === null ||
    !markerStats.isFile() ||
    !ownerMarkerPattern.test(readFileSync(markerPath, "utf8"))
  ) {
    throw refuse(
      dir,
      `has no ${ownerMarkerName} marker, so the showcase scripts did not create it`,
    );
  }

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");

    const allowed =
      entry.name === ".DS_Store" ||
      (entry.isFile() && path === ownerMarkerName) ||
      (entry.isDirectory() && allowedDirectories.has(path)) ||
      (entry.isFile() && generatedFilePatterns.some((pattern) => pattern.test(path)));

    if (!allowed) {
      throw refuse(dir, `contains ${path}, which the showcase scripts did not create`);
    }
  }
}
