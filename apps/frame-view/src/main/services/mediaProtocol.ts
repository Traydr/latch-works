import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { protocol } from 'electron';
import type {
  ThumbnailDebugOptions,
  ThumbnailDiagnosticsSnapshot,
  ThumbnailJobPriority,
  ThumbnailWorkerCapabilities,
} from '../../shared/thumbnail';
import { ThumbnailService, toThumbnailResponse } from './thumbnailService';

export const MEDIA_PROTOCOL_SCHEME = 'frameview-media';

let thumbnailService: ThumbnailService | null = null;
const authorizedMediaRoots = new Set<string>();

async function toCanonicalPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function toComparablePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const comparableTarget = toComparablePath(targetPath);
  const comparableRoot = toComparablePath(rootPath);
  const relative = path.relative(comparableRoot, comparableTarget);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function isAuthorizedMediaPath(mediaPath: string): Promise<boolean> {
  if (authorizedMediaRoots.size === 0) {
    return false;
  }

  const canonicalMediaPath = await toCanonicalPath(mediaPath);
  for (const authorizedRoot of authorizedMediaRoots) {
    if (isPathWithinRoot(canonicalMediaPath, authorizedRoot)) {
      return true;
    }
  }

  return false;
}

function getContentType(mediaPath: string): string {
  const extension = path.extname(mediaPath).toLowerCase();

  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}

type RangeParseResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'missing' | 'malformed' };

export function readRange(rangeHeader: string | null, totalSize: number): RangeParseResult {
  if (!rangeHeader) {
    return { ok: false, reason: 'missing' };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { ok: false, reason: 'malformed' };
  }

  const startRaw = match[1];
  const endRaw = match[2];

  if (!startRaw && !endRaw) {
    return { ok: false, reason: 'malformed' };
  }

  let start = 0;
  let end = totalSize - 1;

  if (startRaw) {
    start = Number(startRaw);
  } else {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { ok: false, reason: 'malformed' };
    }
    start = Math.max(0, totalSize - suffixLength);
  }

  if (endRaw && startRaw) {
    end = Number(endRaw);
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < 0 ||
    start > end ||
    start >= totalSize
  ) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, start, end: Math.min(end, totalSize - 1) };
}

async function fetchMediaFile(request: Request, mediaPath: string): Promise<Response> {
  let fileStats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    fileStats = await fs.stat(mediaPath);
  } catch {
    return new Response('Media file not found', { status: 404 });
  }

  if (!fileStats.isFile()) {
    return new Response('Media path is not a file', { status: 400 });
  }

  const totalSize = fileStats.size;
  const contentType = getContentType(mediaPath);
  const rangeHeader = request.headers.get('range');
  const range = readRange(rangeHeader, totalSize);

  if (!range.ok && range.reason === 'malformed') {
    return new Response(null, {
      status: 416,
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${totalSize}`,
      },
    });
  }

  const isPartial = range.ok;
  const start = range.ok ? range.start : 0;
  const end = range.ok ? range.end : totalSize - 1;
  const contentLength = end - start + 1;

  const headers = {
    'accept-ranges': 'bytes',
    'content-type': contentType,
    'content-length': String(contentLength),
    ...(isPartial ? { 'content-range': `bytes ${start}-${end}/${totalSize}` } : {}),
  };

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: isPartial ? 206 : 200,
      headers,
    });
  }

  const nodeStream = createReadStream(mediaPath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: isPartial ? 206 : 200,
    headers,
  });
}

async function fetchThumbnail(
  mediaPath: string,
  thumbSize: number,
  priority: ThumbnailJobPriority,
  abortSignal?: AbortSignal,
): Promise<Response> {
  if (abortSignal?.aborted) {
    return new Response(null, { status: 204 });
  }

  try {
    const service = thumbnailService;
    if (!service) {
      return fetchMediaFile(new Request('frameview-media://media'), mediaPath);
    }

    const result = await service.getThumbnail(mediaPath, thumbSize, abortSignal, priority);
    return toThumbnailResponse(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return new Response(null, { status: 204 });
    }

    return fetchMediaFile(new Request('frameview-media://media'), mediaPath);
  }
}

export function parseThumbnailPriority(priorityRaw: string | null): ThumbnailJobPriority {
  const priorityValue = Number(priorityRaw ?? '0');
  if (!Number.isFinite(priorityValue)) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(2, Math.floor(priorityValue)));
  if (clamped === 0 || clamped === 1 || clamped === 2) {
    return clamped;
  }
  return 0;
}

export function registerMediaProtocol(userDataPath: string, cachePath: string): void {
  thumbnailService = new ThumbnailService(userDataPath, { cacheRootPath: cachePath });

  protocol.handle(MEDIA_PROTOCOL_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const mediaPath = requestUrl.searchParams.get('path');

      if (!mediaPath) {
        return new Response('Missing media path', { status: 400 });
      }

      if (!path.isAbsolute(mediaPath)) {
        return new Response('Media path must be absolute', { status: 400 });
      }

      if (!(await isAuthorizedMediaPath(mediaPath))) {
        return new Response('Media path is not authorized', { status: 403 });
      }

      if (requestUrl.hostname === 'thumb') {
        const sizeRaw = Number(requestUrl.searchParams.get('size') ?? '256');
        const thumbSize = Number.isFinite(sizeRaw)
          ? Math.max(64, Math.min(1024, Math.floor(sizeRaw)))
          : 256;
        const priority = parseThumbnailPriority(requestUrl.searchParams.get('priority'));
        return fetchThumbnail(mediaPath, thumbSize, priority, request.signal);
      }

      return fetchMediaFile(request, mediaPath);
    } catch {
      return new Response('Invalid media request', { status: 400 });
    }
  });
}

export async function authorizeMediaRoot(rootPath: string): Promise<void> {
  if (!rootPath) {
    return;
  }

  const canonicalRoot = await toCanonicalPath(rootPath);
  authorizedMediaRoots.add(canonicalRoot);
}

export async function clearThumbnailCache(): Promise<void> {
  if (!thumbnailService) {
    return;
  }

  await thumbnailService.clearCache();
}

export function shutdownThumbnailService(): void {
  thumbnailService?.shutdown();
  thumbnailService = null;
}

export function getThumbnailDiagnostics(): ThumbnailDiagnosticsSnapshot | null {
  return thumbnailService?.getDiagnosticsSnapshot() ?? null;
}

export function getThumbnailWorkerCapabilities(): ThumbnailWorkerCapabilities | null {
  return thumbnailService?.getCapabilities() ?? null;
}

export function setThumbnailDebugOptions(options: ThumbnailDebugOptions): void {
  thumbnailService?.setDebugOptions(options);
}
