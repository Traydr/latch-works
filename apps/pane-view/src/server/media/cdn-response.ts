import { Readable } from "node:stream";
import { getStoredObject } from "@latch-works/media-storage";
import { readCdnCacheControl, verifyCdnDeliveryToken } from "./cdn-delivery";
import { createPaneViewStorageClient } from "./storage-client";

export async function serveCdnDeliveryRequest({
  request,
  token,
}: {
  request: Request;
  token: string;
}): Promise<Response> {
  const payload = verifyCdnDeliveryToken(token);
  if (!payload) {
    return new Response("Forbidden", { status: 403 });
  }

  const rangeHeader = request.headers.get("range") ?? undefined;
  const storage = createPaneViewStorageClient();
  const object = await getStoredObject({
    key: payload.objectKey,
    range: rangeHeader,
    storage,
  });

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  if (rangeHeader && object.statusCode === 200) {
    return new Response("Range not satisfiable", { status: 416 });
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": readCdnCacheControl(),
    "content-type": object.contentType ?? "application/octet-stream",
  });

  if (object.contentLength !== undefined) {
    headers.set("content-length", String(object.contentLength));
  }

  if (object.contentRange) {
    headers.set("content-range", object.contentRange);
  }

  if (object.etag) {
    headers.set("etag", object.etag);
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      headers,
      status: object.statusCode,
    });
  }

  const body = Readable.toWeb(object.body) as ReadableStream<Uint8Array>;

  return new Response(body, {
    headers,
    status: object.statusCode,
  });
}
