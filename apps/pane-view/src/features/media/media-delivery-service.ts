import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const resolveMediaDeliveryRequestSchema = z.object({
  mediaId: z.string().uuid(),
  size: z.number().int().positive().optional(),
  variant: z.enum(["thumbnail", "preview", "original"]),
});

const regenerateMediaThumbnailSchema = z.object({
  mediaId: z.string().uuid(),
  size: z.number().int().positive().optional(),
});

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
