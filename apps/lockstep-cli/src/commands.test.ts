import type { LockstepPlan } from "@latch-works/lockstep-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { planSync, pruneDeleted, pushChanges, runDoctorCore } = vi.hoisted(() => ({
  planSync: vi.fn(),
  pruneDeleted: vi.fn(),
  pushChanges: vi.fn(),
  runDoctorCore: vi.fn(),
}));

vi.mock("@latch-works/lockstep-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@latch-works/lockstep-core")>();
  return {
    ...actual,
    doctor: runDoctorCore,
    planSync,
    pruneDeleted,
    pushChanges,
  };
});

import { executeCommand } from "./commands.js";
import type { CliOptions } from "./types.js";

function createPlan(overrides: Partial<LockstepPlan> = {}): LockstepPlan {
  return {
    counts: { delete: 0, keep: 0, update: 0, upload: 0 },
    items: [],
    skipped: 0,
    skippedEntries: [],
    sourceRoot: "/tmp/archive",
    totalBytes: 0,
    totalFiles: 0,
    ...overrides,
  };
}

function createPruneOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    apiUrl: "http://localhost:3000",
    command: "prune",
    hashFiles: false,
    showSkipped: false,
    source: "/tmp/archive",
    yes: false,
    ...overrides,
  };
}

describe("executeCommand prune", () => {
  const originalEnv = process.env;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env = {
      ...originalEnv,
      LOCKSTEP_API_TOKEN: "test-token",
    };
    planSync.mockReset();
    pruneDeleted.mockReset();
    pushChanges.mockReset();
    runDoctorCore.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("does not call pruneDeleted without --yes in non-interactive mode", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );

    await executeCommand(createPruneOptions(), {
      isInteractive: () => false,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("uses remote-aware hashing for push planning", async () => {
    const plan = createPlan();
    planSync.mockResolvedValue(plan);
    pushChanges.mockResolvedValue({ failed: 0, plan, pushed: 0 });

    await executeCommand({
      ...createPruneOptions(),
      command: "push",
    });

    expect(planSync).toHaveBeenCalledWith(
      expect.objectContaining({ hashMode: "remote-aware" }),
      expect.anything(),
    );
    expect(pushChanges).toHaveBeenCalledOnce();
  });

  it("calls pruneDeleted with --yes", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );
    pruneDeleted.mockResolvedValue({ failed: 0, plan: createPlan(), pruned: 1 });

    await executeCommand(createPruneOptions({ yes: true }), {
      isInteractive: () => false,
    });

    expect(pruneDeleted).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("does not prompt or call pruneDeleted when there are zero deletes", async () => {
    planSync.mockResolvedValue(createPlan());
    const confirmPrune = vi.fn();

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      isInteractive: () => true,
    });

    expect(confirmPrune).not.toHaveBeenCalled();
    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("requires interactive confirmation when --yes is absent", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );
    pruneDeleted.mockResolvedValue({ failed: 0, plan: createPlan(), pruned: 1 });
    const confirmPrune = vi.fn().mockResolvedValue(true);

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      isInteractive: () => true,
    });

    expect(confirmPrune).toHaveBeenCalledOnce();
    expect(pruneDeleted).toHaveBeenCalledOnce();
  });

  it("exits non-zero when interactive confirmation is declined", async () => {
    planSync.mockResolvedValue(
      createPlan({
        counts: { delete: 1, keep: 0, update: 0, upload: 0 },
        items: [{ action: "delete", path: "old.jpg" }],
      }),
    );
    const confirmPrune = vi.fn().mockResolvedValue(false);

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      isInteractive: () => true,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
