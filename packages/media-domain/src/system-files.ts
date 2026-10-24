const SYSTEM_JUNK_FILE_NAMES = new Set([
  ".ds_store",
  "desktop.ini",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "thumbs.db",
]);

/**
 * Glazier moves removed files and replaced originals here, inside their own root, so a removal
 * is a same-volume rename that can be undone. Every scanner skips it, so nothing in it is indexed
 * by Frame View or synced by Lockstep.
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
