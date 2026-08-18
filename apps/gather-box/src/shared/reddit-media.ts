import { z } from "zod";

export const RESOLVE_REDGIFS_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_REDGIFS_MEDIA" as const;

export const ResolveRedgifsMediaMessageSchema = z.object({
  type: z.literal(RESOLVE_REDGIFS_MEDIA_MESSAGE),
  // The id is interpolated into a Redgifs API path, so only slug characters are accepted.
  redgifsId: z.string().regex(/^[a-z0-9]{3,100}$/i)
});

export type ResolveRedgifsMediaMessage = z.infer<typeof ResolveRedgifsMediaMessageSchema>;

export interface ResolvedRedgifsMedia {
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
}

export type ResolveRedgifsMediaResponse =
  | { ok: true; media: ResolvedRedgifsMedia }
  | { ok: false; message: string };
