import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MediaDeliveryBatchResult } from "../../server/media/resolve-delivery-url";

const resolveMediaDeliveryRequestSchema = z.object({
  mediaId: z.uuid(),
  size: z.number().int().positive().optional(),
  variant: z.enum(["thumbnail", "preview", "original"]),
});

const resolveMediaDeliveryBatchRequestSchema = z.object({
  items: z.array(resolveMediaDeliveryRequestSchema).min(1).max(48),
});

export const resolveMediaDeliveryUrl = createServerFn({ method: "GET" })
  .validator(resolveMediaDeliveryRequestSchema)
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

export const resolveMediaDeliveryUrls = createServerFn({ method: "POST" })
  .validator(resolveMediaDeliveryBatchRequestSchema)
  .handler(async ({ data }): Promise<{ results: MediaDeliveryBatchResult[] }> => {
    const { isCurrentWebSessionValid } = await import("../../server/auth/web-session");

    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    const { resolveMediaDeliveryUrlsForVariants } = await import(
      "../../server/media/resolve-delivery-url"
    );

    const results = await resolveMediaDeliveryUrlsForVariants(data.items);

    return { results };
  });
