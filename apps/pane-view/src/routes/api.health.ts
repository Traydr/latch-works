import { createFileRoute } from "@tanstack/react-router";
import { shutterConfig } from "../server/media/shutter-config";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          variants: shutterConfig.mode === "on" ? "shutter" : "pass-through",
          shutterApi: shutterConfig.mode === "on" ? (shutterConfig.resolverId ? "v2" : "v1") : null,
          service: "pane-view",
        }),
    },
  },
});
