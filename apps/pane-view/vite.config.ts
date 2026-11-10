import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

const serverExternal = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@better-auth/drizzle-adapter",
  // pdfjs-dist's native canvas backend: Vite's dep optimizer must not scan it
  // (the platform binary is not valid UTF-8).
  "@napi-rs/canvas",
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
    // Workspace packages resolve to their source, so dev and builds never use a stale build.
    conditions: ["source", ...defaultClientConditions],
    tsconfigPaths: true,
  },
  ssr: {
    external: [...serverExternal, "pdfjs-dist"],
    resolve: { conditions: ["source", ...defaultServerConditions] },
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
