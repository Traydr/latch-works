import { createFileRoute } from "@tanstack/react-router";
import { getShutterCapabilityKeyStatus } from "../server/media/shutter-client";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const shutterCapability = getShutterCapabilityKeyStatus();
        return Response.json({
          ok: shutterCapability.ok,
          service: "pane-view",
          shutter: shutterCapability.ok
            ? {
                capabilityKeyReady: true,
                kid: shutterCapability.kid,
                spaceId: shutterCapability.spaceId,
              }
            : {
                capabilityKeyReady: false,
                kid: shutterCapability.kid,
                spaceId: shutterCapability.spaceId,
                error: shutterCapability.error,
              },
        });
      },
    },
  },
});
