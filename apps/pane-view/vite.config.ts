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
  // Externalized so the heavy generation package (and its sharp/ffmpeg deps) is
  // resolved at runtime via dynamic import only in inline mode, never bundled
  // into the always-loaded Pane View server graph.
  "@latch-works/media-derivatives",
  "@latch-works/media-derivatives/descriptor",
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
  plugins: [
    nitro({
      handlers: [
        {
          route: "/**",
          handler: new URL("./src/server/spa-shell-fallback.ts", import.meta.url).pathname,
          middleware: true,
        },
      ],
    }),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          outputPath: "/_shell.html",
        },
      },
    }),
    viteReact(),
  ],
  envPrefix: "VITE_",
});
