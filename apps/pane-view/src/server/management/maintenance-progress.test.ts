import { describe, expect, it } from "vitest";
import {
  initialProgressFor,
  type MaintenanceJobType,
  parseMaintenanceProgress,
} from "./maintenance-progress";

const TYPES: MaintenanceJobType[] = [
  "library_hard_wipe",
  "soft_deleted_purge",
  "shutter_source_purge",
];

describe("parseMaintenanceProgress", () => {
  it.each(TYPES)("accepts each %s phase and the initial progress", (type) => {
    const initial = initialProgressFor(type);
    expect(parseMaintenanceProgress(type, initial)).toEqual({ ok: true, progress: initial });
    expect(parseMaintenanceProgress(type, { phase: "completed", processedCount: 12 })).toEqual({
      ok: true,
      progress: { phase: "completed", processedCount: 12 },
    });
  });

  it("rejects a phase that belongs to another type", () => {
    expect(
      parseMaintenanceProgress("soft_deleted_purge", { phase: "s3_originals", processedCount: 0 }),
    ).toEqual({
      ok: false,
      reason: 'phase "s3_originals" is not valid for soft_deleted_purge',
    });
    expect(
      parseMaintenanceProgress("library_hard_wipe", { phase: "orphaned_media", processedCount: 0 })
        .ok,
    ).toBe(false);
    expect(
      parseMaintenanceProgress("shutter_source_purge", {
        phase: "db_hard_delete",
        processedCount: 0,
      }).ok,
    ).toBe(false);
  });

  it("maps the retired s3_derivatives phase to s3_originals for a wipe only", () => {
    expect(
      parseMaintenanceProgress("library_hard_wipe", { phase: "s3_derivatives", processedCount: 4 }),
    ).toEqual({
      ok: true,
      progress: { phase: "s3_originals", processedCount: 4 },
    });
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        phase: "s3_derivatives",
        processedCount: 4,
      }),
    ).toEqual({
      ok: false,
      reason: 'phase "s3_derivatives" is not valid for soft_deleted_purge',
    });
    expect(
      parseMaintenanceProgress("shutter_source_purge", {
        phase: "s3_derivatives",
        processedCount: 4,
      }).ok,
    ).toBe(false);
  });

  it("ignores extra keys such as the retired errorCount and lastError", () => {
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        errorCount: 0,
        lastError: "boom",
        phase: "orphaned_media",
        processedCount: 3,
        unknown: true,
      }),
    ).toEqual({ ok: true, progress: { phase: "orphaned_media", processedCount: 3 } });
  });

  it("passes the orphan sweep cursor through for a wipe and drops it for other types", () => {
    expect(
      parseMaintenanceProgress("library_hard_wipe", {
        orphanContinuationToken: "token",
        orphanPrefix: "originals/",
        phase: "s3_orphan_sweep",
        processedCount: 9,
      }),
    ).toEqual({
      ok: true,
      progress: {
        orphanContinuationToken: "token",
        orphanPrefix: "originals/",
        phase: "s3_orphan_sweep",
        processedCount: 9,
      },
    });
    expect(
      parseMaintenanceProgress("library_hard_wipe", {
        orphanPrefix: 7,
        phase: "s3_orphan_sweep",
        processedCount: 9,
      }),
    ).toEqual({ ok: true, progress: { phase: "s3_orphan_sweep", processedCount: 9 } });
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        orphanPrefix: "originals/",
        phase: "orphaned_media",
        processedCount: 0,
      }),
    ).toEqual({ ok: true, progress: { phase: "orphaned_media", processedCount: 0 } });
  });

  it("rejects a malformed processedCount, phase, or container", () => {
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        phase: "orphaned_media",
        processedCount: -1,
      }).ok,
    ).toBe(false);
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        phase: "orphaned_media",
        processedCount: "3",
      }).ok,
    ).toBe(false);
    expect(
      parseMaintenanceProgress("soft_deleted_purge", {
        phase: "orphaned_media",
        processedCount: 1.5,
      }).ok,
    ).toBe(false);
    expect(parseMaintenanceProgress("soft_deleted_purge", { phase: 3, processedCount: 0 }).ok).toBe(
      false,
    );
    expect(parseMaintenanceProgress("soft_deleted_purge", null).ok).toBe(false);
    expect(parseMaintenanceProgress("soft_deleted_purge", []).ok).toBe(false);
    expect(parseMaintenanceProgress("soft_deleted_purge", "orphaned_media").ok).toBe(false);
  });
});
