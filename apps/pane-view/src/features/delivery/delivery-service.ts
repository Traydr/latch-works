import { createServerFn } from "@tanstack/react-start";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";
import { DeliveryBatchRequestSchema, type DeliveryResult } from "./delivery-contract";

export const resolveMediaDeliveryUrls = createServerFn({ method: "POST" })
  .validator(DeliveryBatchRequestSchema)
  .handler(async ({ data }): Promise<{ results: DeliveryResult[] }> => {
    await assertWebSessionAuthorized();

    const { resolveMediaDeliveryUrls } = await import("../../server/media/resolve-delivery-url");

    return { results: await resolveMediaDeliveryUrls(data.items) };
  });
