/** The lowercased extension of a file name or path, without the dot; "" when it has none. */
export function getFileExtension(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dotIndex = lastSegment.lastIndexOf(".");

  return dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : "";
}

/** Swaps a file name's extension, or appends one when it has none. */
export function replaceFileExtension(fileName: string, extension: string): string {
  const lastSlashIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex > lastSlashIndex + 1 ? fileName.slice(0, dotIndex) : fileName;

  return `${baseName}.${extension}`;
}
