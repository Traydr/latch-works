/** How long a media-resolution request to X or RedGIFs may take before it is abandoned. */
const MEDIA_REQUEST_TIMEOUT_MS = 12_000;

export function fetchWithTimeout(input: URL | string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS) });
}
