import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The throwaway sample archive the screenshot scripts generate and sync. It is deliberately not
 * configurable through LOCKSTEP_SOURCE: that variable names a real archive, and the scripts
 * write sample files into this directory.
 */
export const showcaseArchiveDir = "/tmp/showcase-archive";

const allowedDirectories = new Set(["sfw", "sfw/photos", "sfw/scans"]);

const generatedFilePatterns = [/^sfw\/photos\/sample-\d{2}\.jpg$/, /^sfw\/scans\/scan-\d{2}\.jpg$/];

/**
 * Throws unless every entry under `dir` is one the showcase generators create, so a script can
 * never write sample files into a real archive. A missing directory passes.
 */
export function assertShowcaseArchive(dir = showcaseArchiveDir) {
  if (!existsSync(dir)) {
    return;
  }

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");

    const allowed =
      entry.name === ".DS_Store" ||
      (entry.isDirectory() && allowedDirectories.has(path)) ||
      (entry.isFile() && generatedFilePatterns.some((pattern) => pattern.test(path)));

    if (!allowed) {
      throw new Error(
        `${dir} contains ${path}, which the showcase scripts did not create. Refusing to write ` +
          "sample media into what may be a real archive; move it aside or delete the directory.",
      );
    }
  }
}
