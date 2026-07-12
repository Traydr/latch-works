import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const serverExternal = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@better-auth/drizzle-adapter",
  // Externalized so the heavy generation package (and its sharp/ffmpeg deps) is
  // resolved at runtime via dynamic import only in inline mode, never bundled
  // into the always-loaded Pane View server graph.
  "@latch-works/media-storage",
  // Native canvas backend for PDF rendering — must not be scanned by Vite's
  // dep optimizer (the platform binary is not valid UTF-8).
  "@napi-rs/canvas",
  "ffmpeg-static",
  "sharp",
  "better-auth",
  "better-auth/tanstack-start",
];

export default defineConfig({
  build: {
    rollupOptions: {
      external: serverExternal,
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: [...serverExternal, "pdfjs-dist"],
  },
  optimizeDeps: {
    exclude: ["@napi-rs/canvas", "pdfjs-dist"],
  },
  server: {
    port: 3000,
  },
  plugins: [nitro(), tailwindcss(), tanstackStart(), viteReact()],
  envPrefix: "VITE_",
});
