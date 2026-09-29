import type { LockstepPlan } from "@latch-works/lockstep-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CoreCommands, executeCommand } from "./commands.js";
import type { CliOptions } from "./types.js";

const planSync = vi.fn();

const pruneDeleted = vi.fn();

const pushChanges = vi.fn();

const runDoctorCore = vi.fn();

const core: CoreCommands = {
  doctor: runDoctorCore,
  planSync,
  pruneDeleted,
  pushChanges,
};

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
      core,
      isInteractive: () => false,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("uses remote-aware hashing for push planning", async () => {
    const plan = createPlan();
    planSync.mockResolvedValue(plan);
    pushChanges.mockResolvedValue({ failed: 0, plan, pushed: 0 });

    await executeCommand(createPruneOptions({ command: "push" }), { core });

    expect(planSync).toHaveBeenCalledWith(
      expect.objectContaining({ hashMode: "remote-aware" }),
      expect.anything(),
    );
    expect(pushChanges).toHaveBeenCalledOnce();
  });

  it("prunes the plan it printed with --yes, without planning again", async () => {
    const printedPlan = createPlan({
      counts: { delete: 1, keep: 0, update: 0, upload: 0 },
      items: [{ action: "delete", path: "old.jpg" }],
    });

    planSync.mockResolvedValue(printedPlan);
    pruneDeleted.mockResolvedValue({ failed: 0, plan: printedPlan, pruned: 1, skipped: 0 });

    await executeCommand(createPruneOptions({ maxChanges: 5, yes: true }), {
      core,
      isInteractive: () => false,
    });

    expect(planSync).toHaveBeenCalledOnce();
    expect(pruneDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxChanges: 1, plan: printedPlan }),
      expect.anything(),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("prints every delete it applies before confirming, however many there are", async () => {
    const paths = Array.from({ length: 30 }, (_, index) => `old-${index}.jpg`);

    const plan = createPlan({
      counts: { delete: paths.length, keep: 0, update: 0, upload: 0 },
      items: paths.map((path) => ({ action: "delete" as const, path })),
    });

    const printed: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => printed.push(line));
    planSync.mockResolvedValue(plan);
    pruneDeleted.mockResolvedValue({ failed: 0, plan, pruned: 25, skipped: 0 });
    const confirmPrune = vi.fn().mockResolvedValue(true);

    await executeCommand(createPruneOptions({ maxChanges: 25 }), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    const listed = printed.filter((line) => line.startsWith("  delete "));
    expect(listed).toEqual(paths.slice(0, 25).map((path) => `  delete ${path}`));
    expect(confirmPrune).toHaveBeenCalledExactlyOnceWith(25);
    expect(pruneDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ maxChanges: 25, plan }),
      expect.anything(),
    );
  });

  it("does not prompt or call pruneDeleted when there are zero deletes", async () => {
    planSync.mockResolvedValue(createPlan());
    const confirmPrune = vi.fn();

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      core,
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
    pruneDeleted.mockResolvedValue({ failed: 0, plan: createPlan(), pruned: 1, skipped: 0 });
    const confirmPrune = vi.fn().mockResolvedValue(true);

    await executeCommand(createPruneOptions(), {
      confirmPrune,
      core,
      isInteractive: () => true,
    });

    expect(confirmPrune).toHaveBeenCalledExactlyOnceWith(1);
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
      core,
      isInteractive: () => true,
    });

    expect(pruneDeleted).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
