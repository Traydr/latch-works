import { describe, expect, it } from "vitest";
import { bytesToMegabytes } from "./stats-chart-data";

describe("stats chart data", () => {
  it("converts byte values to megabytes for chart display", () => {
    expect(bytesToMegabytes(44 * 1024 * 1024 * 1024)).toBe(45_056);
    expect(bytesToMegabytes(1.5 * 1024 * 1024)).toBe(1.5);
  });
});
