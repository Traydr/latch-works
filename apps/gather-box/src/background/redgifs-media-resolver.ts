import { z } from "zod";
import type { ResolveRedgifsMediaResponse, ResolvedRedgifsMedia } from "../shared/reddit-media";

const REDGIFS_TEMPORARY_AUTH_URL = "https://api.redgifs.com/v2/auth/temporary";
const REQUEST_TIMEOUT_MS = 12_000;

type Fetcher = typeof fetch;

const RedgifsAuthResponseSchema = z.object({ token: z.string().min(1) });

/** RedGIFs only serves a handful of URL fields, and each is optional per gif. */
const RedgifsUrlsSchema = z.object({
  hd: z.string().optional(),
  sd: z.string().optional(),
  poster: z.string().optional(),
  thumbnail: z.string().optional()
});

export const RedgifsGifResponseSchema = z
  .object({ gif: z.object({ urls: RedgifsUrlsSchema }) })
  .catch({ gif: { urls: {} } });

export type RedgifsGifResponse = z.infer<typeof RedgifsGifResponseSchema>;

export async function resolveRedgifsMedia(
  redgifsId: string,
  fetcher: Fetcher = fetch
): Promise<ResolveRedgifsMediaResponse> {
  try {
    const normalizedId = redgifsId.toLowerCase();
    const authResponse = await fetchWithTimeout(fetcher, REDGIFS_TEMPORARY_AUTH_URL);
    if (!authResponse.ok) {
      return failed(`temporary authorization returned HTTP ${authResponse.status}`);
    }

    const auth = RedgifsAuthResponseSchema.safeParse(await authResponse.json());
    if (!auth.success) {
      return failed("temporary authorization did not return a token");
    }

    const gifResponse = await fetchWithTimeout(
      fetcher,
      `https://api.redgifs.com/v2/gifs/${encodeURIComponent(normalizedId)}?views=yes`,
      {
        headers: {
          authorization: `Bearer ${auth.data.token}`,
          "content-type": "application/json",
          "x-customheader": `https://www.redgifs.com/watch/${normalizedId}`
        }
      }
    );
    if (!gifResponse.ok) {
      return failed(`media lookup returned HTTP ${gifResponse.status}`);
    }

    const media = parseRedgifsMedia(
      RedgifsGifResponseSchema.parse(await gifResponse.json()),
      normalizedId
    );
    return media ? { ok: true, media } : failed("media lookup did not return a valid MP4 URL");
  } catch (error) {
    return failed(error instanceof Error ? error.message : "unknown RedGIFs error");
  }
}

export function parseRedgifsMedia(
  body: RedgifsGifResponse,
  redgifsId: string
): ResolvedRedgifsMedia | null {
  const { urls } = body.gif;

  const originalUrl = [urls.hd, urls.sd].find(isAllowedRedgifsMp4Url);
  if (originalUrl === undefined) {
    return null;
  }

  const thumbnailUrl = [urls.poster, urls.thumbnail].find(isAllowedRedgifsUrl);
  const fileName = getUrlFileName(originalUrl) || `${redgifsId}.mp4`;

  return {
    originalUrl,
    thumbnailUrl: thumbnailUrl ?? null,
    fileName: fileName.toLowerCase().endsWith(".mp4") ? fileName : `${redgifsId}.mp4`
  };
}

function isAllowedRedgifsMp4Url(value: string | undefined): value is string {
  if (!isAllowedRedgifsUrl(value)) {
    return false;
  }

  return new URL(value).pathname.toLowerCase().endsWith(".mp4");
}

function isAllowedRedgifsUrl(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "redgifs.com" || url.hostname.endsWith(".redgifs.com"))
    );
  } catch {
    return false;
  }
}

function getUrlFileName(value: string): string {
  return decodeURIComponent(new URL(value).pathname.split("/").pop() ?? "");
}

function fetchWithTimeout(
  fetcher: Fetcher,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetcher(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function failed(message: string): ResolveRedgifsMediaResponse {
  return { ok: false, message: `Could not resolve RedGIFs media: ${message}.` };
}
