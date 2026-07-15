export const RESOLVE_REDGIFS_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_REDGIFS_MEDIA" as const;

export interface ResolveRedgifsMediaMessage {
  type: typeof RESOLVE_REDGIFS_MEDIA_MESSAGE;
  redgifsId: string;
}

export interface ResolvedRedgifsMedia {
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
}

export type ResolveRedgifsMediaResponse =
  | { ok: true; media: ResolvedRedgifsMedia }
  | { ok: false; message: string };

export function isResolveRedgifsMediaMessage(
  message: unknown
): message is ResolveRedgifsMediaMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === RESOLVE_REDGIFS_MEDIA_MESSAGE &&
    "redgifsId" in message &&
    typeof message.redgifsId === "string" &&
    /^[a-z0-9]{3,100}$/i.test(message.redgifsId)
  );
}
