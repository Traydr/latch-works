import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "@aws-sdk/client-s3",
        "@aws-sdk/s3-request-presigner",
        "@latch-works/media-storage",
        "tslib",
      ],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: [
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "@latch-works/media-storage",
      "tslib",
    ],
  },
  server: {
    port: 3000,
  },
  plugins: [nitro(), tanstackStart(), viteReact()],
  envPrefix: "VITE_",
});
