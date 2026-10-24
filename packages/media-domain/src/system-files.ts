const SYSTEM_JUNK_FILE_NAMES = new Set([
  ".ds_store",
  "desktop.ini",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "thumbs.db",
]);

/**
 * Glazier's holding folder on a volume other than its data folder's, at the top of that volume,
 * where removed files and replaced originals wait. (Older Glazier builds kept it inside each
 * root.) Every scanner skips it, so a scan of the whole volume neither indexes nor syncs it.
 */
export const GLAZIER_HOLDING_DIRECTORY_NAME = ".glazier-holding";

const SYSTEM_JUNK_DIRECTORY_NAMES = new Set([
  GLAZIER_HOLDING_DIRECTORY_NAME,
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
