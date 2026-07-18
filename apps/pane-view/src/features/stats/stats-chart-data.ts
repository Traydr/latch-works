const BYTES_PER_MEGABYTE = 1024 * 1024;

export function bytesToMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MEGABYTE;
}
