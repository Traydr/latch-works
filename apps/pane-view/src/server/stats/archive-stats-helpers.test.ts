import { describe, expect, it } from "vitest";
import {
  averageDailyGrowth,
  daysBetween,
  fillDailyBuckets,
  formatDayLabel,
  projectForward,
  toCumulativeSeries,
  toDayKey,
} from "./archive-stats-helpers";

describe("archive-stats-helpers", () => {
  it("formats day keys and labels in UTC", () => {
    expect(toDayKey(new Date("2026-03-15T18:22:00.000Z"))).toBe("2026-03-15");
    expect(formatDayLabel("2026-03-15")).toBe("Mar 15");
  });

  it("fills missing days with zeros", () => {
    expect(
      fillDailyBuckets(
        [
          { day: "2026-01-01", value: 10 },
          { day: "2026-01-03", value: 5 },
        ],
        { endDay: "2026-01-03", startDay: "2026-01-01" },
      ),
    ).toEqual([
      { day: "2026-01-01", value: 10 },
      { day: "2026-01-02", value: 0 },
      { day: "2026-01-03", value: 5 },
    ]);
  });

  it("builds a cumulative size series", () => {
    expect(
      toCumulativeSeries([
        { day: "2026-01-01", value: 100 },
        { day: "2026-01-02", value: 50 },
        { day: "2026-01-03", value: 25 },
      ]),
    ).toEqual([
      { day: "2026-01-01", label: "Jan 1", value: 100 },
      { day: "2026-01-02", label: "Jan 2", value: 150 },
      { day: "2026-01-03", label: "Jan 3", value: 175 },
    ]);
  });

  it("averages growth from archive birth for brand-new archives", () => {
    const daily = [
      { day: "2026-01-01", value: 0 },
      { day: "2026-01-02", value: 0 },
      { day: "2026-01-03", value: 30 },
      { day: "2026-01-04", value: 30 },
      { day: "2026-01-05", value: 30 },
    ];

    expect(averageDailyGrowth(daily, 5, "2026-01-05", { archiveStartedOn: "2026-01-03" })).toBe(30);
  });

  it("counts quiet days for archives that already existed before the window", () => {
    const daily = [
      { day: "2026-01-01", value: 0 },
      { day: "2026-01-02", value: 0 },
      { day: "2026-01-03", value: 0 },
      { day: "2026-01-04", value: 0 },
      { day: "2026-01-05", value: 100 },
    ];

    expect(averageDailyGrowth(daily, 5, "2026-01-05", { archiveStartedOn: "2025-06-01" })).toBe(20);
  });

  it("returns zero when nothing was added in the window", () => {
    expect(
      averageDailyGrowth(
        [
          { day: "2026-01-01", value: 0 },
          { day: "2026-01-05", value: 0 },
        ],
        5,
        "2026-01-05",
        { archiveStartedOn: "2025-01-01" },
      ),
    ).toBe(0);
  });

  it("projects future size from the current total and daily rate", () => {
    expect(projectForward(1000, 10, 90)).toBe(1900);
  });

  it("computes archive age in whole days", () => {
    expect(
      daysBetween(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-10T12:00:00.000Z")),
    ).toBe(10);
    expect(daysBetween(null, new Date())).toBeNull();
  });
});
