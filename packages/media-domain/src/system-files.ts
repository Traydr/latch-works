const SYSTEM_JUNK_FILE_NAMES = new Set([
  ".ds_store",
  "desktop.ini",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "thumbs.db",
]);

const SYSTEM_JUNK_DIRECTORY_NAMES = new Set([
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
