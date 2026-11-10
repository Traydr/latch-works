import {
  canonicalizeExtension,
  type ImageExtensions,
  MediaTypeSchema,
  type PdfExtensions,
  type VideoExtensions,
} from "@latch-works/media-domain";

/** A content hash as the sync API carries it: SHA-256, hex, either case. */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** S3's single-PUT object size limit; a larger original would need a multipart upload. */
export const MAX_SYNC_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/** The media types an archived original can have: every detected type but `unknown`. */
export const ArchiveMediaTypeSchema = MediaTypeSchema.exclude(["unknown"]);

type MediaExtension =
  | (typeof ImageExtensions)[number]
  | (typeof PdfExtensions)[number]
  | (typeof VideoExtensions)[number];

const OCTET_STREAM = "application/octet-stream";

/**
 * The content type an upload of each media extension is signed with. `bmp` and `mkv` have no type
 * Shutter's Source Delivery passes through, so they upload as bytes and Pane View signs their
 * delivery URLs itself.
 */
const CONTENT_TYPES = {
  avif: "image/avif",
  bmp: OCTET_STREAM,
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4v: "video/mp4",
  mkv: OCTET_STREAM,
  mov: "video/quicktime",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  webm: "video/webm",
  webp: "image/webp",
} satisfies Record<MediaExtension, string>;

const contentTypeByExtension = new Map<string, string>(Object.entries(CONTENT_TYPES));

/**
 * The content type an upload declares for an extension, as written (`JPG` is not `jpg`). Pane View
 * signs the upload with it and rejects a registration that declares another.
 */
export function contentTypeForExtension(extension: string): string {
  return contentTypeByExtension.get(extension) ?? OCTET_STREAM;
}

/** Every original a sync uploads is stored under this prefix. */
export const ORIGINALS_PREFIX = "originals/";

const ORIGINALS_SHA256_PREFIX = `${ORIGINALS_PREFIX}sha256/`;

/**
 * Where an original is stored: `originals/sha256/aa/bb/<hash>.<ext>`, keyed by its lowercase hash
 * and canonical extension. The media type is not part of the key. Shutter's resolver key template
 * (`originals/sha256/{shard_a}/{shard_b}/{object}`) names the same layout.
 */
export function originalObjectKey({
  extension,
  sha256,
}: {
  extension: string;
  sha256: string;
}): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid sha256 value: ${sha256}`);
  }

  const hash = sha256.toLowerCase();

  return `${ORIGINALS_SHA256_PREFIX}${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${canonicalizeExtension(extension)}`;
}

/**
 * The key's segments after `originals/sha256/` (two shards and the object name), or undefined for
 * a key outside the layout `originalObjectKey` writes.
 */
export function originalObjectKeySegments(objectKey: string): readonly string[] | undefined {
  if (!objectKey.startsWith(ORIGINALS_SHA256_PREFIX)) return undefined;

  const segments = objectKey.slice(ORIGINALS_SHA256_PREFIX.length).split("/");

  return segments.length === 3 && segments.every((part) => part !== "") ? segments : undefined;
}
