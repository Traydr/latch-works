import { describe, expect, it } from "vitest";
import { formatBytes } from "./format.js";

const kibibyte = 1024;

const byteCounts: readonly number[] = [
  // Bytes, and the ties toFixed rounds up.
  0,
  1,
  2,
  2.5,
  3.5,
  51.2,
  512,
  1000,
  1023,
  1023.4,
  1023.5,
  1023.96,
  // Each unit's boundaries, its ties (1.25 and 1.75 of a unit) and values that round up to 1024.
  kibibyte,
  kibibyte + 1,
  1075,
  1075.2,
  1126.4,
  1280,
  1331.2,
  1536,
  1792,
  2304,
  10240,
  kibibyte ** 2 - 1,
  kibibyte ** 2,
  kibibyte ** 2 + 1,
  1.05 * kibibyte ** 2,
  1.25 * kibibyte ** 2,
  123_456_789,
  kibibyte ** 3 - 1,
  kibibyte ** 3,
  kibibyte ** 3 + 1,
  1.75 * kibibyte ** 3,
  5 * kibibyte ** 3,
  kibibyte ** 4 - 1,
  kibibyte ** 4,
  kibibyte ** 4 + 1,
  // Past TB the unit is missing from the table.
  kibibyte ** 5 - 2,
  kibibyte ** 5 - 1,
  kibibyte ** 5,
  kibibyte ** 6,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 64,
  1e300,
  Number.MAX_VALUE,
  // Below one byte the unit is missing too, and negative counts are not a number.
  1 - Number.EPSILON / 2,
  0.5,
  0.001,
  1e-310,
  Number.MIN_VALUE,
  -1,
  -1024,
];

describe("formatBytes", () => {
  it("formats byte counts as the snapshot", () => {
    expect(byteCounts.map((bytes) => ({ bytes, formatted: formatBytes(bytes) }))).toMatchSnapshot();
  });
});
