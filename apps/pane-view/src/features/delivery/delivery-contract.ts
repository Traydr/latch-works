import type { MediaType } from "@latch-works/media-domain";
import { z } from "zod";

/**
 * How media URLs reach the browser: what the client asks for, what the server
 * answers, and how long an answer stays good. Environment-neutral, so the
 * server function, the server resolver, and the client cache read one
 * definition.
 */

const RENDITION_VARIANTS = ["thumbnail", "preview"] as const;

export type DeliveryVariant = (typeof RENDITION_VARIANTS)[number] | "original";

/** The width, in device pixels, every grid tile asks for whatever its size on screen. */
export const THUMBNAIL_WIDTH = 720;

/**
 * The CSS width each surface shows a preview at; callers scale it to device
 * pixels. The viewer's matches its neighbour prefetch, so a step lands on a
 * cached URL.
 */
export const PREVIEW_CSS_WIDTH = { comicPage: 960, detailPanel: 360, viewer: 1080 } as const;

/** Most items one batch resolves. */
export const MAX_DELIVERY_BATCH = 48;

/**
 * How long every delivery URL stays valid: the Shutter capability lifetime,
 * matched by the signed bucket URL. The client cache drops a URL before then.
 */
export const DELIVERY_URL_LIFETIME_SECONDS = 24 * 60 * 60;

/** Media types the gallery can show a picture of: images directly, video and PDF as previews. */
export function hasDeliverableRendition(mediaType: MediaType): boolean {
  return mediaType !== "unknown";
}

/** What a full-size view shows: a still image's preview, anything else (gif, video, PDF) its original. */
export function fullViewVariant(mediaType: MediaType): DeliveryVariant {
  return mediaType === "image" ? "preview" : "original";
}

/** A rendition names the width it is shown at, in device pixels; the original has none. */
const DeliveryRequestSchema = z.discriminatedUnion("variant", [
  z.object({ mediaId: z.uuid(), variant: z.literal("original") }),
  z.object({
    mediaId: z.uuid(),
    variant: z.enum(RENDITION_VARIANTS),
    width: z.number().int().positive(),
  }),
]);

export type DeliveryRequest = z.infer<typeof DeliveryRequestSchema>;

export const DeliveryBatchRequestSchema = z.object({
  items: z.array(DeliveryRequestSchema).min(1).max(MAX_DELIVERY_BATCH),
});

/** Identifies one request, so the server resolves it once and the client matches its answer. */
export function deliveryKey(request: DeliveryRequest): string {
  return request.variant === "original"
    ? `original:${request.mediaId}`
    : `${request.variant}:${request.mediaId}:${request.width}`;
}

/**
 * One item's answer. `pending` means Shutter is still rendering a preview;
 * `unavailable` that no rendition exists in this configuration (video or PDF
 * with Shutter off), so asking again cannot help; `failed` may pass.
 */
export type DeliveryOutcome =
  | { status: "ready"; url: string }
  | { retryAfterMs: number; status: "pending" }
  | { status: "failed" }
  | { status: "unavailable" };

export type DeliveryResult = DeliveryRequest & DeliveryOutcome;
