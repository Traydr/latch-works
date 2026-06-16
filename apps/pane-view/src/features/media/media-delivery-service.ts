import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const resolveMediaDeliveryRequestSchema = z.object({
  mediaId: z.string().uuid(),
  size: z.number().int().positive().optional(),
  variant: z.enum(["thumbnail", "preview", "original"]),
});

const resolveMediaDeliveryBatchRequestSchema = z.object({
  items: z.array(resolveMediaDeliveryRequestSchema).min(1).max(48),
});

const regenerateMediaThumbnailSchema = z.object({
  mediaId: z.string().uuid(),
  size: z.number().int().positive().optional(),
});

export type MediaDeliveryBatchResult =
  | { mediaId: string; retryAfterMs: number; size?: number; status: "pending"; variant: string }
  | {
      deliveryToken?: string;
      mediaId: string;
      size?: number;
      status: "ready";
      url?: string;
      variant: string;
    }
  | { mediaId: string; size?: number; status: "failed"; variant: string };

export const regenerateMediaThumbnail = createServerFn({ method: "POST" })
  .inputValidator(regenerateMediaThumbnailSchema)
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { isCurrentWebSessionValid } = await import("../../server/auth/web-session");
    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    const { regenerateMediaThumbnailDerivative } = await import(
      "../../server/media/resolve-delivery-url"
    );

    return regenerateMediaThumbnailDerivative({
      mediaId: data.mediaId,
      size: data.size,
    });
  });

export const resolveMediaDeliveryUrl = createServerFn({ method: "GET" })
  .inputValidator(resolveMediaDeliveryRequestSchema)
  .handler(async ({ data }) => {
    const { isCurrentWebSessionValid } = await import("../../server/auth/web-session");
    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    const { resolveMediaDeliveryUrlForVariant } = await import(
      "../../server/media/resolve-delivery-url"
    );

    return resolveMediaDeliveryUrlForVariant({
      mediaId: data.mediaId,
      size: data.size,
      variant: data.variant,
    });
  });

function batchKey(item: z.infer<typeof resolveMediaDeliveryRequestSchema>): string {
  return `${item.variant}:${item.mediaId}:${item.size ?? "default"}`;
}

export const resolveMediaDeliveryUrls = createServerFn({ method: "POST" })
  .inputValidator(resolveMediaDeliveryBatchRequestSchema)
  .handler(async ({ data }): Promise<{ results: MediaDeliveryBatchResult[] }> => {
    const { isCurrentWebSessionValid } = await import("../../server/auth/web-session");
    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    const { resolveMediaDeliveryUrlsForVariants } = await import(
      "../../server/media/resolve-delivery-url"
    );

    const seen = new Set<string>();
    const uniqueItems = data.items.filter((item) => {
      const key = batchKey(item);
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

    const results = await resolveMediaDeliveryUrlsForVariants(uniqueItems);

    return { results };
  });
