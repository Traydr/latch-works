import { execFileSync } from "node:child_process";
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

/**
 * Names this build for the service worker, which keeps one set of caches per build (plan 066). A
 * deploy can set PANE_VIEW_BUILD_ID; otherwise the commit and the build time make it unique.
 */
function resolveBuildId(): string {
  if (process.env.PANE_VIEW_BUILD_ID) return process.env.PANE_VIEW_BUILD_ID;

  let commit = "unversioned";

  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // Built outside a git checkout, such as a container build: the build time alone stays unique.
  }

  return `${commit}-${Date.now().toString(36)}`;
}

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
  plugins: [
    nitro({
      routeRules: {
        // Plan 066: the browser checks the worker on every launch, so it must never be served
        // from a cache, and it may control the whole site.
        "/sw.js": {
          headers: { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" },
        },
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  envPrefix: "VITE_",
  define: {
    "import.meta.env.VITE_PANE_VIEW_BUILD_ID": JSON.stringify(resolveBuildId()),
  },
});
