import mdx from "@astrojs/mdx";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/** Frame View, Glazier and the Lockstep desktop app became Oriel's View, Tidy and Sync modes. */
const orielRedirects = {
  "/frame-view": "/oriel",
  "/lockstep": "/oriel",
  "/docs/frame-view": "/docs/oriel",
  "/docs/frame-view/browsing": "/docs/oriel/view",
  "/docs/frame-view/viewer": "/docs/oriel/viewer",
  "/docs/frame-view/comics-and-stories": "/docs/oriel/view",
  "/docs/frame-view/preferences": "/docs/oriel/settings",
  "/docs/frame-view/troubleshooting": "/docs/oriel/troubleshooting",
  "/docs/lockstep": "/docs/oriel/sync",
  "/docs/lockstep/setup": "/docs/oriel/sync",
  "/docs/lockstep/plan": "/docs/oriel/sync",
  "/docs/lockstep/push": "/docs/oriel/sync",
  "/docs/lockstep/verify-and-doctor": "/docs/lockstep-cli",
  "/docs/lockstep/cli": "/docs/lockstep-cli",
};

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react(), mdx()],
  redirects: orielRedirects,
  server: {
    host: "0.0.0.0",
    port: 3100,
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
  },
});
