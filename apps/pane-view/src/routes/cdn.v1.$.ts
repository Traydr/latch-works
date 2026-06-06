import { createFileRoute } from "@tanstack/react-router";
import { serveCdnDeliveryRequest } from "../server/media/cdn-response";

export const Route = createFileRoute("/cdn/v1/$")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { _splat?: string }; request: Request }) => {
        const token = params._splat;
        if (!token) {
          return new Response("Not found", { status: 404 });
        }

        return serveCdnDeliveryRequest({ request, token });
      },
      HEAD: async ({ params, request }: { params: { _splat?: string }; request: Request }) => {
        const token = params._splat;
        if (!token) {
          return new Response("Not found", { status: 404 });
        }

        return serveCdnDeliveryRequest({ request, token });
      },
    },
  },
});
