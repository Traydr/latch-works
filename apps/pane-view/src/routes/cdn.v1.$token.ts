import { createFileRoute } from "@tanstack/react-router";
import { serveCdnDeliveryRequest } from "../server/media/cdn-response";

export const Route = createFileRoute("/cdn/v1/$token")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { token: string }; request: Request }) =>
        serveCdnDeliveryRequest({ request, token: params.token }),
      HEAD: async ({ params, request }: { params: { token: string }; request: Request }) =>
        serveCdnDeliveryRequest({ request, token: params.token }),
    },
  },
});
