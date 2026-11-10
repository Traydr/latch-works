import type { MediaType } from "@latch-works/media-domain";
import { contentTypeForExtension } from "@latch-works/sync-protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  DELIVERY_URL_LIFETIME_SECONDS,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryResult,
  deliveryKey,
} from "@/features/delivery/delivery-contract";
import { createConcurrencyLimiter } from "@/lib/concurrency-limiter";
import { db } from "../db";
import { libraryEntries, mediaObjects } from "../db/schema";
import {
  type EnabledShutter,
  resolveShutterImageUrl,
  resolveShutterOriginalUrl,
  resolveShutterPreview,
} from "./shutter-client";
import { type ShutterConfig, shutterConfig } from "./shutter-config";
import { createSignedGetUrl } from "./storage-client";

const shutterControlLimiter = createConcurrencyLimiter(6);

/** One live library entry's original, as delivery reads it. */
interface MediaDeliveryRow {
  extension: string;
  mediaType: MediaType;
  objectKey: string;
  sha256: string;
}

/**
 * The content types Shutter's Source Delivery passes through (its
 * `docs/contracts/v1/source-delivery.md`). Lockstep signs the upload's
 * Content-Type from the extension, so the type an original was stored with is
 * the type Shutter sees; anything else Shutter answers 415. The `mkv` and
 * `bmp` originals Lockstep accepts upload as `application/octet-stream`, so
 * they stay signed.
 */
const SHUTTER_SOURCE_DELIVERY_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/pdf",
]);

function deliversThroughShutter(
  row: MediaDeliveryRow,
  shutter: ShutterConfig,
): shutter is EnabledShutter {
  return (
    shutter.mode === "on" &&
    SHUTTER_SOURCE_DELIVERY_TYPES.has(contentTypeForExtension(row.extension))
  );
}

/** There is no live library entry with this id. */
export class MediaDeliveryNotFoundError extends Error {
  constructor() {
    super("Media not found");
    this.name = "MediaDeliveryNotFoundError";
  }
}

async function readDeliveryRows(
  mediaIds: readonly string[],
): Promise<Map<string, MediaDeliveryRow>> {
  const rows =
    mediaIds.length === 0
      ? []
      : await db
          .select({
            entryId: libraryEntries.id,
            extension: mediaObjects.extension,
            mediaType: mediaObjects.mediaType,
            objectKey: mediaObjects.objectKey,
            sha256: mediaObjects.sha256,
          })
          .from(libraryEntries)
          .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
          .where(and(inArray(libraryEntries.id, [...mediaIds]), isNull(libraryEntries.deletedAt)));

  return new Map(rows.map(({ entryId, ...row }) => [entryId, row]));
}

/**
 * The original itself: playback, the PDF viewer, and the download link. It
 * goes through Shutter when Shutter is on and passes the object's content
 * type through, so the edge answers repeat plays and seeks; the rest is a
 * signed bucket URL.
 */
function resolveOriginal(row: MediaDeliveryRow, shutter: ShutterConfig): Promise<string> {
  if (deliversThroughShutter(row, shutter)) return resolveShutterOriginalUrl(row, shutter);

  return createSignedGetUrl({
    expiresInSeconds: DELIVERY_URL_LIFETIME_SECONDS,
    key: row.objectKey,
  });
}

/**
 * One item. Without Shutter an image rendition is the signed original (the
 * requested width is moot) and video and PDF have no preview, so their tiles
 * show a placeholder while the viewer plays the original.
 */
async function resolveRow(
  row: MediaDeliveryRow,
  request: DeliveryRequest,
  shutter: ShutterConfig,
): Promise<DeliveryOutcome> {
  if (request.variant === "original") {
    return { status: "ready", url: await resolveOriginal(row, shutter) };
  }

  const { width } = request;

  if (row.mediaType === "image" || row.mediaType === "gif") {
    const url =
      shutter.mode === "on"
        ? await resolveShutterImageUrl(row, width, shutter)
        : await resolveOriginal(row, shutter);

    return { status: "ready", url };
  }

  if (shutter.mode === "off" || (row.mediaType !== "video" && row.mediaType !== "pdf")) {
    return { status: "unavailable" };
  }

  const kind = row.mediaType;

  const preview = await shutterControlLimiter.run(() =>
    resolveShutterPreview(row, kind, width, shutter),
  );

  if (preview.status === "failed") {
    console.warn(
      `[pane-view] Shutter preview failed for ${request.mediaId}${preview.code ? ` (${preview.code})` : ""}`,
    );

    return { status: "failed" };
  }

  return preview;
}

/**
 * Resolve each distinct item once (repeats are dropped from the results).
 * Every failure becomes that item's `failed` and is logged here, since the
 * client only sees a placeholder.
 */
export async function resolveMediaDeliveryUrls(
  items: readonly DeliveryRequest[],
  shutter: ShutterConfig = shutterConfig,
): Promise<DeliveryResult[]> {
  const unique = [...new Map(items.map((item) => [deliveryKey(item), item])).values()];
  const rows = await readDeliveryRows([...new Set(unique.map((item) => item.mediaId))]);

  return Promise.all(
    unique.map(async (item): Promise<DeliveryResult> => {
      const row = rows.get(item.mediaId);

      if (!row) return { ...item, status: "failed" };

      try {
        return { ...item, ...(await resolveRow(row, item, shutter)) };
      } catch (error) {
        console.error(`[pane-view] Unable to resolve ${deliveryKey(item)}`, error);

        return { ...item, status: "failed" };
      }
    }),
  );
}

/** The original's URL for the download route; throws MediaDeliveryNotFoundError without a live entry. */
export async function resolveOriginalDeliveryUrl(mediaId: string): Promise<string> {
  const row = (await readDeliveryRows([mediaId])).get(mediaId);

  if (!row) throw new MediaDeliveryNotFoundError();

  return resolveOriginal(row, shutterConfig);
}
