import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockstepRunEvent } from "../../src/shared/types";

const pushChanges = vi.fn();
const pruneDeleted = vi.fn();
const planSync = vi.fn();

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => buffer.toString("utf-8")),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf-8")),
    isEncryptionAvailable: vi.fn(() => true),
  },
}));

vi.mock("@latch-works/lockstep-core", async () => {
  const actual = await vi.importActual<typeof import("@latch-works/lockstep-core")>(
    "@latch-works/lockstep-core",
  );
  return {
    ...actual,
    planSync,
    pruneDeleted,
    pushChanges,
  };
});

describe("RunService cancellation summaries", () => {
  let tempDir: string;
  let profileId: string;
  let sentEvents: LockstepRunEvent[];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-run-service-"));
    sentEvents = [];
    pushChanges.mockReset();
    pruneDeleted.mockReset();
    planSync.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createRunService() {
    const { ProfileService } = await import("../../src/main/services/profileService");
    const { RunService } = await import("../../src/main/services/runService");

    const profileService = new ProfileService(tempDir, {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
    });
    await profileService.init();

    const created = await profileService.createProfile({
      apiUrl: "http://127.0.0.1:3000",
      name: "Local",
      sourceRoot: "/tmp/archive",
      token: "secret-token",
    });
    if (created.status !== "ok") {
      throw new Error("Failed to create profile.");
    }
    profileId = created.value.id;

    const runService = new RunService(profileService, () => ({
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: LockstepRunEvent) => {
          sentEvents.push(event);
        },
      },
    }));

    return runService;
  }

  it("reports cancelled push runs with action push", async () => {
    const runService = await createRunService();

    pushChanges.mockImplementation(async (_options, observer) => {
      observer?.onEvent({
        type: "complete",
        summary: {
          action: "push",
          completedAt: new Date().toISOString(),
          failed: 0,
          pushed: 0,
          status: "cancelled",
        },
      });
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      runService.push({
        hashFiles: true,
        profileId,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const completeEvents = sentEvents.filter((event) => event.type === "complete");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toMatchObject({
      summary: {
        action: "push",
        status: "cancelled",
      },
    });
  });

  it("uses remote-aware hashing for desktop pushes", async () => {
    const runService = await createRunService();
    const plan = {
      counts: { delete: 0, keep: 0, update: 0, upload: 0 },
      items: [],
      skipped: 0,
      skippedEntries: [],
      sourceRoot: "/tmp/archive",
      totalBytes: 0,
      totalFiles: 0,
    };
    pushChanges.mockResolvedValue({ failed: 0, plan, pushed: 0 });

    await runService.push({ profileId });

    expect(pushChanges).toHaveBeenCalledWith(
      expect.objectContaining({ hashMode: "remote-aware" }),
      expect.anything(),
    );
  });

  it("reports cancelled prune runs with action prune", async () => {
    const runService = await createRunService();

    pruneDeleted.mockImplementation(async (_options, observer) => {
      observer?.onEvent({
        type: "complete",
        summary: {
          action: "prune",
          completedAt: new Date().toISOString(),
          failed: 0,
          pushed: 0,
          status: "cancelled",
        },
      });
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      runService.prune({
        hashFiles: false,
        profileId,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const completeEvents = sentEvents.filter((event) => event.type === "complete");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toMatchObject({
      summary: {
        action: "prune",
        status: "cancelled",
      },
    });
  });

  it("falls back to the active operation when core does not emit complete", async () => {
    const runService = await createRunService();

    planSync.mockImplementation(async (_options, _observer, signal) => {
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    });

    const runPromise = runService.plan({
      hashFiles: false,
      profileId,
    });
    runService.cancel();

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });

    const completeEvents = sentEvents.filter((event) => event.type === "complete");
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toMatchObject({
      summary: {
        action: "plan",
        status: "cancelled",
      },
    });
    expect(sentEvents.some((event) => event.type === "cancelled")).toBe(true);
  });
});
