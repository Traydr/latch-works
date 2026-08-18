import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { uploadFile } from "./remote-api.js";

/** `Server.address()` widens to a pipe name or null; only a bound TCP address is usable. */
const TcpAddressSchema = z.object({ port: z.number() });

const tempDirs: string[] = [];

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = TcpAddressSchema.safeParse(server.address());
  if (!address.success) {
    throw new Error("Expected TCP address");
  }
  return address.data.port;
}

afterEach(async () => {
  // Temp dirs are left for OS cleanup; tests write tiny files only.
  tempDirs.length = 0;
});

async function writeTempFile(contents: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-upload-"));
  tempDirs.push(dir);
  const filePath = join(dir, "sample.bin");
  await writeFile(filePath, contents);
  return filePath;
}

describe("uploadFile", () => {
  it("uploads exact bytes with signed headers and verifies digest", async () => {
    const payload = Buffer.from("hello-lockstep");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const filePath = await writeTempFile(payload);

    let receivedLength = 0;
    let receivedType = "";
    let receivedChecksum = "";
    const server = createServer(async (request, response) => {
      receivedType = String(request.headers["content-type"] ?? "");
      receivedChecksum = String(request.headers["x-amz-checksum-sha256"] ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      receivedLength = Buffer.concat(chunks).length;
      response.writeHead(200);
      response.end();
    });

    const port = await listenOnLoopback(server);

    try {
      await uploadFile({
        contentType: "application/octet-stream",
        expectedSha256: sha256,
        expectedSize: payload.length,
        filePath,
        headers: {
          "Content-Length": String(payload.length),
          "Content-Type": "application/octet-stream",
          "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"),
        },
        uploadUrl: `http://127.0.0.1:${port}/upload`,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(receivedLength).toBe(payload.length);
    expect(receivedType).toBe("application/octet-stream");
    expect(receivedChecksum).toBe(Buffer.from(sha256, "hex").toString("base64"));
  });

  it("destroys the upload stream when aborted", async () => {
    const payload = Buffer.alloc(1024 * 64, 7);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const filePath = await writeTempFile(payload);
    const controller = new AbortController();

    const server = createServer((_request, _response) => {
      // Never respond; client abort should reject fetch.
    });

    const port = await listenOnLoopback(server);

    try {
      const uploadPromise = uploadFile({
        contentType: "application/octet-stream",
        expectedSha256: sha256,
        expectedSize: payload.length,
        filePath,
        headers: {
          "Content-Length": String(payload.length),
          "Content-Type": "application/octet-stream",
        },
        signal: controller.signal,
        uploadUrl: `http://127.0.0.1:${port}/upload`,
      });
      queueMicrotask(() => controller.abort());
      await expect(uploadPromise).rejects.toThrow();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
