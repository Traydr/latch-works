import { z } from "zod";
import { readRequestSessionUserId } from "../auth/web-session-core";
import { MediaDeliveryNotFoundError, resolveOriginalDeliveryUrl } from "./resolve-delivery-url";

function privateResponse(
  body: string | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: { "Cache-Control": "private, no-store", ...headers },
    status,
  });
}

/**
 * `/api/media/:id/original`, the download link: redirect a signed-in owner to
 * the original's URL (302), or answer 404 when there is no such media and 502
 * when the URL cannot be made.
 */
export async function redirectToOriginal({
  mediaId,
  request,
}: {
  mediaId: string;
  request: Request;
}): Promise<Response> {
  if ((await readRequestSessionUserId({ request })) === null) {
    return privateResponse("Unauthorized", 401);
  }

  // A media id that is not a UUID names no entry; don't hand it to Postgres.
  if (!z.uuid().safeParse(mediaId).success) {
    return privateResponse("Media not found", 404);
  }

  try {
    return privateResponse(null, 302, { Location: await resolveOriginalDeliveryUrl(mediaId) });
  } catch (error) {
    if (error instanceof MediaDeliveryNotFoundError) {
      return privateResponse("Media not found", 404);
    }

    console.error(`[pane-view] Unable to resolve the original of ${mediaId}`, error);

    return privateResponse("Original unavailable", 502);
  }
}
