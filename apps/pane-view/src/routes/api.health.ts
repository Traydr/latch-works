import { createFileRoute } from "@tanstack/react-router";
import { resolveDerivativeProcessingMode } from "../env/server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        let ffmpegAvailable = false;
        if (resolveDerivativeProcessingMode() === "inline") {
          const ffmpegPath = (await import("ffmpeg-static")).default;
          ffmpegAvailable = Boolean(ffmpegPath);
        }

        return Response.json({
          ffmpegAvailable,
          ok: true,
          service: "pane-view",
        });
      },
    },
  },
});
