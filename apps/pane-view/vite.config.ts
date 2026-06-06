import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const serverExternal = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@better-auth/drizzle-adapter",
  "@latch-works/media-delivery",
  "@latch-works/media-storage",
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
    exclude: ["pdfjs-dist"],
  },
  server: {
    port: 3000,
  },
  plugins: [nitro(), tailwindcss(), tanstackStart(), viteReact()],
  envPrefix: "VITE_",
});
