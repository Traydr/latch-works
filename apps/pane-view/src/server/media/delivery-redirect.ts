import { createSignedGetUrl } from "@latch-works/media-storage";
import { API_PRIVATE_CACHE_CONTROL } from "./cdn-delivery";
import { createPaneViewStorageClient } from "./storage-client";

export async function redirectToSignedStoredObject({
  expiresInSeconds = 300,
  objectKey,
}: {
  expiresInSeconds?: number;
  objectKey: string;
}): Promise<Response> {
  const signedUrl = await createSignedGetUrl({
    expiresInSeconds,
    key: objectKey,
    storage: createPaneViewStorageClient(),
  });

  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: signedUrl,
    },
    status: 302,
  });
}
