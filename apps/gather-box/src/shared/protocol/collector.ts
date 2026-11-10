import * as z from "zod/mini";
import { sendChannelRequest } from "../messaging";
import { CollectionResultSchema, SiteKeySchema } from "../types";
import { type ResolveXMediaResponse, XPostQuerySchema } from "../x-media";

/**
 * Service worker and an injected collector. The service worker asks the collector for the page's
 * output; the collector asks the service worker to resolve media that needs extension privileges.
 */

export const COLLECT_MESSAGE_TYPE = "GATHER_BOX_COLLECT";

export const CollectMessageSchema = z.object({
  type: z.literal(COLLECT_MESSAGE_TYPE),
  requestId: z.string(),
  sourceKey: SiteKeySchema,
  pageUrl: z.string(),
  /** The page address as the source's URL pattern parsed it. */
  address: z.record(z.string(), z.string()),
});

export type CollectMessage = z.infer<typeof CollectMessageSchema>;

/** The collector's answer, checked against the request it answers before it is trusted. */
export const CollectResponseSchema = z.object({
  requestId: z.string(),
  sourceKey: SiteKeySchema,
  result: CollectionResultSchema,
});

export type CollectResponse = z.infer<typeof CollectResponseSchema>;

export const RESOLVE_X_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_X_MEDIA";

export const RESOLVE_REDGIFS_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_REDGIFS_MEDIA";

export const CollectorRequestSchema = z.discriminatedUnion("type", [
  z.extend(XPostQuerySchema, { type: z.literal(RESOLVE_X_MEDIA_MESSAGE) }),
  z.object({
    type: z.literal(RESOLVE_REDGIFS_MEDIA_MESSAGE),
    // The id is interpolated into a Redgifs API path, so only slug characters are accepted.
    redgifsId: z.string().check(z.regex(/^[a-z0-9]{3,100}$/i)),
  }),
]);

export type CollectorRequest = z.infer<typeof CollectorRequestSchema>;

export type ResolveXMediaRequest = Extract<
  CollectorRequest,
  { type: typeof RESOLVE_X_MEDIA_MESSAGE }
>;

export interface ResolvedRedgifsMedia {
  originalUrl: string;
  fileName: string;
}

export interface CollectorResponses {
  [RESOLVE_X_MEDIA_MESSAGE]: ResolveXMediaResponse;
  [RESOLVE_REDGIFS_MEDIA_MESSAGE]: { ok: true; media: ResolvedRedgifsMedia };
}

export interface FailedCollectorRequest {
  ok: false;
  message: string;
}

export function failCollectorRequest(message: string): FailedCollectorRequest {
  return { ok: false, message };
}

export function sendCollectorRequest<Request extends CollectorRequest>(
  request: Request,
): Promise<CollectorResponses[Request["type"]] | FailedCollectorRequest> {
  return sendChannelRequest(request, failCollectorRequest);
}
