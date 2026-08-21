import { createFileRoute } from "@tanstack/react-router";
import { getShutterCapabilityKeyStatus } from "../server/media/shutter-client";
import { isShutterConfigured } from "../server/media/variant-provider";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const shutter = isShutterConfigured();
        return Response.json({
          ok: shutter ? getShutterCapabilityKeyStatus().ok : true,
          variants: shutter ? "shutter" : "pass-through",
          service: "pane-view",
        });
      },
    },
  },
});
