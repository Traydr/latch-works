import { z } from "zod";
import { isRequestSessionValid } from "../auth/web-session-core";
import {
  MediaDeliveryNotFoundError,
  type MediaDeliveryResolveResult,
  MediaDeliveryUnavailableError,
  resolveMediaDeliveryUrlForVariant,
} from "./resolve-delivery-url";

const API_PRIVATE_CACHE_CONTROL = "private, no-store";

const NOT_FOUND_MESSAGES = {
  media: "Media not found",
  preview: "Preview not found",
  variant: "Variant not found",
} as const satisfies Record<MediaDeliveryNotFoundError["missing"], string>;

const UNAVAILABLE_MESSAGES = {
  image: "Thumbnail unavailable",
  original: "Original unavailable",
  preview: "Preview unavailable",
} as const satisfies Record<MediaDeliveryUnavailableError["resolver"], string>;

/** A positive integer `?size=`, or undefined so the variant's default width applies. */
function readRequestedSize(request: Request): number | undefined {
  const size = Number(new URL(request.url).searchParams.get("size"));

  return Number.isInteger(size) && size > 0 ? size : undefined;
}

function privateResponse(
  body: string | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL, ...headers },
    status,
  });
}

/**
 * The `/api/media/:id/{thumbnail,preview,original}` routes: redirect a signed-in
 * owner to the variant's URL (302), ask them to retry while Shutter renders a
 * preview (503), or answer 404 when there is nothing to deliver and 502 when a
 * resolver fails.
 */
export async function redirectToMediaDelivery({
  mediaId,
  request,
  variant,
}: {
  mediaId: string;
  request: Request;
  variant: "thumbnail" | "preview" | "original";
}): Promise<Response> {
  if (!(await isRequestSessionValid({ request }))) {
    return privateResponse("Unauthorized", 401);
  }

  // A media id that is not a UUID names no entry; don't hand it to Postgres.
  if (!z.uuid().safeParse(mediaId).success) {
    return privateResponse(NOT_FOUND_MESSAGES.media, 404);
  }

  let result: MediaDeliveryResolveResult;

  try {
    result = await resolveMediaDeliveryUrlForVariant({
      mediaId,
      size: readRequestedSize(request),
      variant,
    });
  } catch (error) {
    if (error instanceof MediaDeliveryNotFoundError) {
      return privateResponse(NOT_FOUND_MESSAGES[error.missing], 404);
    }

    if (error instanceof MediaDeliveryUnavailableError) {
      return privateResponse(UNAVAILABLE_MESSAGES[error.resolver], 502);
    }

    throw error;
  }

  if (result.pending) {
    return privateResponse("Preview is being generated", 503, {
      "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))),
    });
  }

  return privateResponse(null, 302, { Location: result.url });
}
