import type {
  ResolveRedgifsMediaResponse,
  ResolvedRedgifsMedia
} from "../shared/reddit-media";

const REDGIFS_TEMPORARY_AUTH_URL = "https://api.redgifs.com/v2/auth/temporary";
const REQUEST_TIMEOUT_MS = 12_000;

type Fetcher = typeof fetch;

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

    const authBody = (await authResponse.json()) as { token?: unknown };
    if (typeof authBody.token !== "string" || !authBody.token) {
      return failed("temporary authorization did not return a token");
    }

    const gifResponse = await fetchWithTimeout(
      fetcher,
      `https://api.redgifs.com/v2/gifs/${encodeURIComponent(normalizedId)}?views=yes`,
      {
        headers: {
          authorization: `Bearer ${authBody.token}`,
          "content-type": "application/json",
          "x-customheader": `https://www.redgifs.com/watch/${normalizedId}`
        }
      }
    );
    if (!gifResponse.ok) {
      return failed(`media lookup returned HTTP ${gifResponse.status}`);
    }

    const media = parseRedgifsMedia(await gifResponse.json(), normalizedId);
    return media ? { ok: true, media } : failed("media lookup did not return a valid MP4 URL");
  } catch (error) {
    return failed(error instanceof Error ? error.message : "unknown RedGIFs error");
  }
}

export function parseRedgifsMedia(body: unknown, redgifsId: string): ResolvedRedgifsMedia | null {
  if (!isObject(body)) {
    return null;
  }
  const gif = body.gif;
  if (!isObject(gif)) {
    return null;
  }
  const urls = gif.urls;
  if (!isObject(urls)) {
    return null;
  }

  const originalUrl = [urls.hd, urls.sd].find(isAllowedRedgifsMp4Url);
  if (typeof originalUrl !== "string") {
    return null;
  }

  const thumbnailUrl = [urls.poster, urls.thumbnail].find(isAllowedRedgifsUrl);
  const fileName = getUrlFileName(originalUrl) || `${redgifsId}.mp4`;

  return {
    originalUrl,
    thumbnailUrl: typeof thumbnailUrl === "string" ? thumbnailUrl : null,
    fileName: fileName.toLowerCase().endsWith(".mp4") ? fileName : `${redgifsId}.mp4`
  };
}

function isAllowedRedgifsMp4Url(value: unknown): value is string {
  if (!isAllowedRedgifsUrl(value)) {
    return false;
  }

  return new URL(value).pathname.toLowerCase().endsWith(".mp4");
}

function isAllowedRedgifsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
