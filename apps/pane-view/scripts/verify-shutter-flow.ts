import { readMediaThumbnailContext } from "../src/server/media/repository";
import { resolveShutterImageUrl } from "../src/server/media/shutter-client";

async function main(): Promise<void> {
  const mediaId = process.argv[2] ?? "a0db80a8-8e03-43bd-9285-cf8b4d8c1a5d";
  const context = await readMediaThumbnailContext({ mediaId });
  if (!context) {
    throw new Error(`Media context not found for ${mediaId}`);
  }

  const url = await resolveShutterImageUrl(context, 720);
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();

  console.log(
    JSON.stringify({
      bytes: bytes.byteLength,
      status: response.status,
      type: response.headers.get("content-type"),
      url,
    }),
  );
}

void main();
