export * from "./s3.js";

export interface ObjectKeyParts {
  extension: string;
  sha256: string;
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
  const cleaned = extension.replace(/^\./, "").toLowerCase();
  // Keep in sync with canonicalizeExtension in @latch-works/media-domain.
  return cleaned === "jpeg" ? "jpg" : cleaned;
}

/** Content-addressed key for an immutable original. mediaType is not part of the key. */
export function originalObjectKey({ extension, sha256 }: ObjectKeyParts): string {
  const normalizedHash = sha256.toLowerCase();
  return `originals/sha256/${shardPath(normalizedHash)}/${normalizedHash}.${cleanExtension(extension)}`;
}
