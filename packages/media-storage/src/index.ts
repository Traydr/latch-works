import type { MediaType } from "@latch-works/media-domain";

export * from "./s3.js";

export interface ObjectKeyParts {
  extension: string;
  mediaType: MediaType;
  sha256: string;
}

export interface DerivedObjectKeyParts extends ObjectKeyParts {
  size: number;
}

function assertSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Invalid sha256 value: ${sha256}`);
  }
}

function shardPath(sha256: string): string {
  assertSha256(sha256);
  return `${sha256.slice(0, 2).toLowerCase()}/${sha256.slice(2, 4).toLowerCase()}`;
}

function cleanExtension(extension: string): string {
  return extension.replace(/^\./, "").toLowerCase();
}

export function originalObjectKey({ extension, sha256 }: ObjectKeyParts): string {
  const normalizedHash = sha256.toLowerCase();
  return `originals/sha256/${shardPath(normalizedHash)}/${normalizedHash}.${cleanExtension(extension)}`;
}

export function thumbnailObjectKey({ sha256, size }: DerivedObjectKeyParts): string {
  const normalizedHash = sha256.toLowerCase();
  return `thumbnails/sha256/${shardPath(normalizedHash)}/${normalizedHash}-${size}.webp`;
}

export function previewObjectKey({ mediaType, sha256, size }: DerivedObjectKeyParts): string {
  const normalizedHash = sha256.toLowerCase();
  const previewType = mediaType === "story" ? "pdf" : mediaType;
  return `previews/${previewType}/sha256/${shardPath(normalizedHash)}/${normalizedHash}-${size}.webp`;
}

export function syncRunManifestKey(syncRunId: string): string {
  return `manifests/sync-runs/${syncRunId}.jsonl`;
}
