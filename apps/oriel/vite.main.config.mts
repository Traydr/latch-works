import { defineConfig } from "vite";

// The native runtime loads from the app's resources at run time, never from the bundle.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "ffmpeg-static",
        "@ffprobe-installer/ffprobe",
        "sharp",
        /^@img\/sharp-/,
        /^@img\/sharp-libvips-/,
      ],
    },
  },
});
