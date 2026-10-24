const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Bytes in decimal units with one decimal, as the desktop app shows them: "84.6 KB". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

const countFormat = new Intl.NumberFormat("en-US");

/** "1 file", "206 files": a count with the noun that agrees with it. */
export function countOf(count: number, one: string, many: string): string {
  return `${countFormat.format(count)} ${count === 1 ? one : many}`;
}
