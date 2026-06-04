import { createFileRoute } from "@tanstack/react-router";
import ffmpegPath from "ffmpeg-static";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ffmpegAvailable: Boolean(ffmpegPath),
          ok: true,
          service: "pane-view",
        }),
    },
  },
});
