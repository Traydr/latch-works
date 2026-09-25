import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProfileService } from "../../src/main/services/profileService";
import { RunService } from "../../src/main/services/runService";

const TOKEN = "sync-token";

const ListeningAddressSchema = z.object({ port: z.number() });

const DeleteBodySchema = z.object({ action: z.literal("delete"), logicalPath: z.string() });

/** A stand-in for Pane View's sync API: a snapshot of remote entries that deletes remove. */
interface SyncServer {
  apiUrl: string;
  deleted: string[];
  entries: Map<string, number>;
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

  return { apiUrl: `http://127.0.0.1:${port}`, deleted, entries, server };
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

  async function createRunService() {
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

    return { profileId: created.value.id, runService: new RunService(profiles, () => null) };
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
});
