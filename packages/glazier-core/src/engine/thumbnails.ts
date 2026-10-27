import { createHash } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { detectMediaType } from "@latch-works/media-domain";

import { runTool } from "../media/run-tool.js";
import { type MediaToolkit, sharpPath } from "../media/toolkit.js";

const THUMBNAIL_CONCURRENCY = 4;

const FRAME_TIMEOUT_MS = 20_000;

/**
 * Small WebP previews for the renderer, cached under the app's data folder by path, size and
 * modification time, so a changed file gets a new one. Nothing is written inside a root.
 */
export class ThumbnailCache {
  private active = 0;

  private readonly waiting: Array<() => void> = [];

  private readonly failed = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly toolkit: MediaToolkit,
  ) {}

  async get(filePath: string, size: number): Promise<string | null> {
    const fileStat = await stat(filePath).catch(() => null);

    if (!fileStat?.isFile()) {
      return null;
    }

    const key = createHash("sha1")
      .update(`${filePath}|${size}|${Math.trunc(fileStat.mtimeMs)}|${fileStat.size}`)
      .digest("hex");

    const target = path.join(this.directory, key.slice(0, 2), `${key}.webp`);

    if (
      await stat(target).then(
        () => true,
        () => false,
      )
    ) {
      return target;
    }

    if (this.failed.has(key)) {
      return null;
    }

    await this.acquire();

    try {
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      const rendered = await this.render(filePath, size, temp);

      if (!rendered) {
        this.failed.add(key);

        return null;
      }

      await rename(temp, target);

      return target;
    } catch {
      this.failed.add(key);

      return null;
    } finally {
      this.release();
    }
  }

  private async render(filePath: string, size: number, temp: string): Promise<boolean> {
    const { sharp, ffmpegPath } = this.toolkit;
    const mediaType = detectMediaType(path.basename(filePath));

    const toWebp = (input: string | Buffer) =>
      sharp(input, { failOn: "none", limitInputPixels: false })
        .rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toFile(sharpPath(temp));

    if (mediaType !== "video") {
      await toWebp(sharpPath(filePath));

      return true;
    }

    if (ffmpegPath === null) {
      return false;
    }

    for (const seconds of ["1", "0"]) {
      const frame = await runTool({
        executable: ffmpegPath,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          seconds,
          "-i",
          filePath,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        timeoutMs: FRAME_TIMEOUT_MS,
      });

      if (frame.code === 0 && frame.stdout.length > 0) {
        await toWebp(frame.stdout);

        return true;
      }
    }

    return false;
  }

  private acquire(): Promise<void> {
    if (this.active < THUMBNAIL_CONCURRENCY) {
      this.active += 1;

      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
