import * as z from "zod/mini";
import { isAllowedDownloadUrl } from "../shared/download-policy";
import { toError } from "../shared/errors";
import { fetchWithTimeout } from "../shared/fetch";
import { getUrlFileName } from "../shared/path";
import type {
  CollectorResponses,
  FailedCollectorRequest,
  RESOLVE_REDGIFS_MEDIA_MESSAGE,
  ResolvedRedgifsMedia,
} from "../shared/protocol/collector";

type ResolveRedgifsMediaResponse =
  | CollectorResponses[typeof RESOLVE_REDGIFS_MEDIA_MESSAGE]
  | FailedCollectorRequest;

const REDGIFS_TEMPORARY_AUTH_URL = "https://api.redgifs.com/v2/auth/temporary";

const RedgifsAuthResponseSchema = z.object({ token: z.string().check(z.minLength(1)) });

/** Each of the RedGIFs URL fields is optional per gif. */
const RedgifsUrlsSchema = z.object({
  hd: z.optional(z.string()),
  sd: z.optional(z.string()),
});

const RedgifsGifResponseSchema = z.catch(z.object({ gif: z.object({ urls: RedgifsUrlsSchema }) }), {
  gif: { urls: {} },
});

type RedgifsGifResponse = z.infer<typeof RedgifsGifResponseSchema>;

export async function resolveRedgifsMedia(redgifsId: string): Promise<ResolveRedgifsMediaResponse> {
  try {
    const normalizedId = redgifsId.toLowerCase();
    const authResponse = await fetchWithTimeout(REDGIFS_TEMPORARY_AUTH_URL);

    if (!authResponse.ok) {
      return failed(`temporary authorization returned HTTP ${authResponse.status}`);
    }

    const auth = RedgifsAuthResponseSchema.safeParse(await authResponse.json());

    if (!auth.success) {
      return failed("temporary authorization did not return a token");
    }

    const gifResponse = await fetchWithTimeout(
      `https://api.redgifs.com/v2/gifs/${encodeURIComponent(normalizedId)}?views=yes`,
      {
        headers: {
          authorization: `Bearer ${auth.data.token}`,
          "content-type": "application/json",
          "x-customheader": `https://www.redgifs.com/watch/${normalizedId}`,
        },
      },
    );

    if (!gifResponse.ok) {
      return failed(`media lookup returned HTTP ${gifResponse.status}`);
    }

    const media = parseRedgifsMedia(
      RedgifsGifResponseSchema.parse(await gifResponse.json()),
      normalizedId,
    );

    return media ? { ok: true, media } : failed("media lookup did not return a valid MP4 URL");
  } catch (error) {
    return failed(toError(error).message);
  }
}

function parseRedgifsMedia(
  body: RedgifsGifResponse,
  redgifsId: string,
): ResolvedRedgifsMedia | null {
  const { urls } = body.gif;

  const originalUrl = [urls.hd, urls.sd].find(
    (url): url is string => url !== undefined && isAllowedDownloadUrl("reddit", url),
  );

  if (originalUrl === undefined) {
    return null;
  }

  const fileName = getUrlFileName(originalUrl) || `${redgifsId}.mp4`;

  return {
    originalUrl,
    fileName: fileName.toLowerCase().endsWith(".mp4") ? fileName : `${redgifsId}.mp4`,
  };
}

function failed(message: string): ResolveRedgifsMediaResponse {
  return { ok: false, message: `Could not resolve RedGIFs media: ${message}.` };
}
