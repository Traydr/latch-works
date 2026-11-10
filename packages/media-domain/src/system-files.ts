const SYSTEM_JUNK_FILE_NAMES = new Set([
  ".ds_store",
  "desktop.ini",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "thumbs.db",
]);

/**
 * Where Latch Works apps keep their own data: `~/.latch-works` for each app's settings, catalogs
 * and caches, and a `.latch-works` folder at the top of another volume for what has to stay on
 * that volume (Tidy's holding, so a removal there is still a rename). Every scanner skips it, so
 * a scan of a home folder or a whole volume neither indexes nor syncs it.
 */
export const LATCH_WORKS_DIRECTORY_NAME = ".latch-works";

/**
 * Where Tidy held files before holding moved under `.latch-works`. Still skipped, for archives an
 * older build left it in.
 */
export const LEGACY_HOLDING_DIRECTORY_NAME = ".glazier-holding";

const SYSTEM_JUNK_DIRECTORY_NAMES = new Set([
  LATCH_WORKS_DIRECTORY_NAME,
  LEGACY_HOLDING_DIRECTORY_NAME,
  "$recycle.bin",
  ".documentrevisions-v100",
  ".fseventsd",
  ".spotlight-v100",
  ".temporaryitems",
  ".trashes",
  "__macosx",
  "system volume information",
]);

export function isSystemJunkFile(fileName: string): boolean {
  if (fileName.startsWith("._")) {
    return true;
  }

  return SYSTEM_JUNK_FILE_NAMES.has(fileName.toLowerCase());
}

export function isSystemJunkDirectory(directoryName: string): boolean {
  return SYSTEM_JUNK_DIRECTORY_NAMES.has(directoryName.toLowerCase());
}
