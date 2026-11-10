import type { UploadTargetSchema } from "@latch-works/sync-protocol";
import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import { assertNoActiveCleanupJob } from "../server/db/library-guards";
import { createSignedPutUrl, getPaneViewStorageClient } from "../server/media/storage-client";
import { syncRoute } from "../server/sync/route";
import { parseUploadUrlBody } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/upload-url")({
  server: {
    handlers: {
      POST: syncRoute({
        parse: parseUploadUrlBody,
        handle: async ({
          contentType,
          objectKey,
          sha256,
          size,
        }): Promise<z.input<typeof UploadTargetSchema>> => {
          await assertNoActiveCleanupJob();

          const signed = await createSignedPutUrl({
            contentLength: size,
            contentType,
            key: objectKey,
            sha256,
            storage: getPaneViewStorageClient(),
          });

          return { headers: signed.headers, objectKey, uploadUrl: signed.uploadUrl };
        },
      }),
    },
  },
});
