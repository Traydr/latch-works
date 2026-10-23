import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { EngineMethods } from "@latch-works/glazier-core/contract";
import { protocol } from "electron";

import type { EngineHost } from "./engine-host";

const MEDIA_SCHEME = "glazier-media";

/** Must run before the app is ready, so Chromium treats the scheme as a secure, streamable origin. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
} as const satisfies Record<string, string>;

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  return Object.hasOwn(CONTENT_TYPES, extension)
    ? // SAFETY: `Object.hasOwn` just confirmed the extension is one of the table's keys.
      CONTENT_TYPES[extension as keyof typeof CONTENT_TYPES]
    : "application/octet-stream";
}

type ByteRange =
  | { kind: "whole" }
  | { kind: "part"; start: number; end: number }
  | { kind: "invalid" };

function parseRange(header: string | null, size: number): ByteRange {
  if (!header) {
    return { kind: "whole" };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (!match || (!match[1] && !match[2])) {
    return { kind: "invalid" };
  }

  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

  return start <= end && start < size ? { kind: "part", start, end } : { kind: "invalid" };
}

/** Streams an original with HTTP range support, so `<video>` can seek. */
async function serveFile(request: Request, filePath: string): Promise<Response> {
  const fileStat = await stat(filePath).catch(() => null);

  if (!fileStat?.isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const range = parseRange(request.headers.get("range"), fileStat.size);

  if (range.kind === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${fileStat.size}` },
    });
  }

  const start = range.kind === "part" ? range.start : 0;
  const end = range.kind === "part" ? range.end : fileStat.size - 1;

  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": contentType(filePath),
    "content-length": String(Math.max(0, end - start + 1)),
  });

  if (range.kind === "part") {
    headers.set("content-range", `bytes ${start}-${end}/${fileStat.size}`);
  }

  if (fileStat.size === 0) {
    return new Response(null, { status: 200, headers });
  }

  // SAFETY: `Readable.toWeb` returns a WHATWG stream; Node's `stream/web` and the DOM lib declare
  // that one runtime object under two nominally distinct types, and Response needs the DOM one.
  const body = Readable.toWeb(
    createReadStream(filePath, { start, end }),
  ) as ReadableStream<Uint8Array>;

  return new Response(body, { status: range.kind === "part" ? 206 : 200, headers });
}

/**
 * `glazier-media://file/?path=…` serves an original and `glazier-media://thumb/?path=…&size=…` a
 * cached WebP preview. Both only answer for paths inside a configured root.
 */
export function handleMediaProtocol(host: EngineHost): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");

    if (!filePath || !path.isAbsolute(filePath) || !host.isAuthorized(filePath)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (url.hostname === "thumb") {
      const size = Math.max(64, Math.min(1024, Number(url.searchParams.get("size")) || 256));

      try {
        const result = EngineMethods.thumbnail.output.parse(
          await host.call("thumbnail", { path: filePath, size }),
        );

        if (result.path === null) {
          return new Response(null, { status: 204 });
        }

        return new Response(await readFile(result.path), {
          headers: { "content-type": "image/webp", "cache-control": "max-age=3600" },
        });
      } catch {
        return new Response(null, { status: 204 });
      }
    }

    return serveFile(request, filePath);
  });
}
