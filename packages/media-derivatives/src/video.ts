import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getStoredObject, type S3StorageClient } from "@latch-works/media-storage";
import type { FfmpegRunner } from "./types.js";

export function runFfmpeg(binaryPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${String(code)}`));
    });
  });
}

export async function extractVideoPosterFrameFromStorage({
  extension,
  ffmpegPath,
  ffmpegRunner,
  maxBytes,
  sourceKey,
  storage,
}: {
  extension: string;
  ffmpegPath: string | null;
  ffmpegRunner: FfmpegRunner;
  maxBytes: number;
  sourceKey: string;
  storage: S3StorageClient;
}): Promise<Buffer> {
  const stored = await getStoredObject({ key: sourceKey, storage });
  if (!stored?.body) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  if (stored.contentLength !== undefined && stored.contentLength > maxBytes) {
    stored.body.destroy();
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "media-derivatives-"));
  const inputPath = path.join(tempDir, `source.${extension.replace(/^\./, "")}`);

  try {
    await streamReadableToTempFile({
      body: stored.body,
      destinationPath: inputPath,
      maxBytes,
    });
    return await extractVideoPosterFrameAtPath({
      ffmpegPath,
      ffmpegRunner,
      inputPath,
      tempDir,
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function streamReadableToTempFile({
  body,
  destinationPath,
  maxBytes,
}: {
  body: Readable;
  destinationPath: string;
  maxBytes: number;
}): Promise<void> {
  let bytesWritten = 0;

  const byteLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        callback(new Error(`original object exceeds ${maxBytes} bytes`));
        return;
      }

      callback(null, chunk);
    },
  });

  await pipeline(body, byteLimiter, createWriteStream(destinationPath));
}

async function extractVideoPosterFrameAtPath({
  ffmpegPath,
  ffmpegRunner,
  inputPath,
  tempDir,
}: {
  ffmpegPath: string | null;
  ffmpegRunner: FfmpegRunner;
  inputPath: string;
  tempDir: string;
}): Promise<Buffer> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary is not available");
  }

  const outputPath = path.join(tempDir, "poster.jpg");

  await ffmpegRunner(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    "1",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]);

  return await readFile(outputPath);
}
