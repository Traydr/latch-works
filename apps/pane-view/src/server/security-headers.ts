export const APP_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

export const MEDIA_DELIVERY_PATH_PATTERN =
  /^\/cdn\/v1\/|^\/api\/media\/[^/]+\/(?:original|thumbnail|preview)$/;

export function isMediaDeliveryPath(pathname: string): boolean {
  return MEDIA_DELIVERY_PATH_PATTERN.test(pathname);
}

export function applyAppSecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Content-Security-Policy", APP_CONTENT_SECURITY_POLICY);
}

export function applyMediaDeliverySecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
}

export function applySecurityHeadersToResponse(response: Response, pathname: string): Response {
  if (isMediaDeliveryPath(pathname)) {
    applyMediaDeliverySecurityHeaders(response.headers);
    return response;
  }

  applyAppSecurityHeaders(response.headers);
  return response;
}
