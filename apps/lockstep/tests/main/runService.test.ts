import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProfileService } from "../../src/main/services/profileService";
import { RunService } from "../../src/main/services/runService";
import type { LockstepRunEvent } from "../../src/shared/types";

const TOKEN = "sync-token";

const ListeningAddressSchema = z.object({ port: z.number() });

const DeleteBodySchema = z.object({ action: z.literal("delete"), logicalPath: z.string() });

/** A stand-in for Pane View's sync API: a snapshot of remote entries that deletes remove. */
interface SyncServer {
  apiUrl: string;
  deleted: string[];
  entries: Map<string, number>;
  /** Answers a sync run's completion request; by default the server accepts it. */
  onComplete: () => number;
  server: Server;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

async function startSyncServer(initialEntries: Record<string, number>): Promise<SyncServer> {
  const deleted: string[] = [];
  const entries = new Map(Object.entries(initialEntries));
  const sync = { onComplete: () => 200 };

  const server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, json: string) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(json);
      };

      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        send(401, JSON.stringify({ error: "unauthorized" }));

        return;
      }

      if (request.method === "GET" && request.url === "/api/sync/snapshot") {
        send(
          200,
          JSON.stringify({
            entries: [...entries].map(([entryPath, size]) => ({ path: entryPath, size })),
          }),
        );

        return;
      }

      const body = await readBody(request);

      if (request.url === "/api/sync/runs") {
        send(200, JSON.stringify({ syncRunId: "run-1" }));

        return;
      }

      if (request.url === "/api/sync/runs/run-1/complete") {
        const status = sync.onComplete();
        send(status, JSON.stringify(status === 200 ? { status: "ok" } : { error: "unavailable" }));

        return;
      }

      const deletion = DeleteBodySchema.safeParse(JSON.parse(body));

      if (request.url === "/api/sync/complete-object" && deletion.success) {
        deleted.push(deletion.data.logicalPath);
        entries.delete(deletion.data.logicalPath);
      }

      send(200, JSON.stringify({ status: "ok" }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = ListeningAddressSchema.parse(server.address());

  return Object.assign(sync, { apiUrl: `http://127.0.0.1:${port}`, deleted, entries, server });
}

describe("RunService prune", () => {
  let tempDir: string;
  let sourceRoot: string;
  let sync: SyncServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "lockstep-run-"));
    sourceRoot = path.join(tempDir, "source");
    await mkdir(sourceRoot);
    await writeFile(path.join(sourceRoot, "kept.jpg"), "kept");
    sync = await startSyncServer({ "gone-1.jpg": 10, "gone-2.jpg": 10, "kept.jpg": 4 });
  });

  afterEach(async () => {
    await new Promise((resolve) => sync.server.close(resolve));
    await rm(tempDir, { force: true, recursive: true });
  });

  async function createRunService(getMainWindow: () => BrowserWindow | null = () => null) {
    const profiles = new ProfileService(path.join(tempDir, "user-data"), {
      legacyConfigPath: path.join(tempDir, "missing-legacy.json"),
      secretStorage: {
        decryptString: (buffer: Buffer) => buffer.toString("utf-8"),
        encryptString: (value: string) => Buffer.from(value, "utf-8"),
        isEncryptionAvailable: () => true,
      },
    });

    await profiles.init();

    const created = await profiles.createProfile({
      apiUrl: sync.apiUrl,
      name: "Stand-in",
      sourceRoot,
      token: TOKEN,
    });

    if (created.status !== "ok") {
      throw new Error("profile was not created");
    }

    return {
      profileId: created.value.id,
      profiles,
      runService: new RunService(profiles, getMainWindow),
    };
  }

  it("deletes the reviewed plan's deletes once, never a fresh plan's", async () => {
    const { profileId, runService } = await createRunService();
    const plan = await runService.plan({ profileId });

    expect(plan.counts).toMatchObject({ delete: 2, keep: 1 });

    // After review: a new remote entry appears (a fresh plan would delete it) and one planned
    // delete's file comes back locally.
    sync.entries.set("arrived-later.jpg", 10);
    await writeFile(path.join(sourceRoot, "gone-2.jpg"), "back again");

    await expect(runService.prune({ planId: "not-a-plan", profileId })).rejects.toThrow(
      /no longer current/,
    );
    expect(sync.deleted).toEqual([]);

    const summary = await runService.prune({ planId: plan.planId, profileId });

    expect(summary).toMatchObject({ failed: 0, pushed: 1, skipped: 1, status: "completed" });
    expect(sync.deleted).toEqual(["gone-1.jpg"]);
    expect([...sync.entries.keys()].sort()).toEqual([
      "arrived-later.jpg",
      "gone-2.jpg",
      "kept.jpg",
    ]);

    await expect(runService.prune({ planId: plan.planId, profileId })).rejects.toThrow(
      /no longer current/,
    );
    expect(sync.deleted).toEqual(["gone-1.jpg"]);
  });

  it("reports a cancelled prune it could not finalize as a failure and saves it", async () => {
    const { profileId, profiles, runService } = await createRunService();
    const plan = await runService.plan({ profileId });

    // Cancel arrives while the server is refusing to finalize the run.
    sync.onComplete = () => {
      runService.cancel();

      return 503;
    };

    const failure = await runService.prune({ planId: plan.planId, profileId }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ _tag: "RunCancelled" });
    expect(String(failure)).toMatch(/run-1/);
    expect(sync.deleted).toEqual(["gone-1.jpg", "gone-2.jpg"]);
    expect(profiles.getProfile(profileId)?.lastRun).toMatchObject({
      action: "prune",
      message: expect.stringMatching(/sync run run-1 could not be finalized/),
      pushed: 2,
      status: "failed",
    });
  });

  it("announces a run's end only once it is saved and a new window would see it idle", async () => {
    const ends: { action: string; lastRun?: string; running: boolean }[] = [];
    let service: RunService | undefined;
    let profileService: ProfileService | undefined;
    let id = "";

    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: LockstepRunEvent) => {
          if (event.type === "complete") {
            ends.push({
              action: event.summary.action,
              lastRun: profileService?.getProfile(id)?.lastRun?.action,
              running: service?.getActiveRun() !== null,
            });
          }
        },
      },
    };

    const created = await createRunService(() => window as unknown as BrowserWindow);
    ({ profileId: id, profiles: profileService, runService: service } = created);

    const plan = await created.runService.plan({ profileId: id });
    await created.runService.prune({ planId: plan.planId, profileId: id });

    expect(ends).toEqual([
      { action: "plan", lastRun: "plan", running: false },
      { action: "prune", lastRun: "prune", running: false },
    ]);
  });

  it("keeps profile changes and runs apart, whichever starts first", async () => {
    const { profileId, profiles, runService } = await createRunService();

    // An edit accepted first holds off a run that would read the old target.
    const edit = runService.changeProfileWhileIdle(() =>
      profiles.updateProfile(profileId, { apiUrl: "http://127.0.0.1:1" }),
    );

    await expect(runService.plan({ profileId })).rejects.toThrow(/profile change/);
    await expect(edit).resolves.toMatchObject({ status: "ok" });
    expect(profiles.getProfile(profileId)?.lastRun).toBeUndefined();

    // A run started first refuses the edit, which would take its result.
    await profiles.updateProfile(profileId, { apiUrl: sync.apiUrl });
    const plan = runService.plan({ profileId });

    await expect(
      runService.changeProfileWhileIdle(() => profiles.setActiveProfile(profileId)),
    ).resolves.toBeUndefined();
    await expect(plan).resolves.toMatchObject({ counts: { delete: 2 } });
  });
});
