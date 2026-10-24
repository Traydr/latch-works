import { defineConfig } from "vite";

/** The hidden window that runs Mediabunny over WebCodecs; it has a page of its own. */
export default defineConfig({
  build: {
    rollupOptions: {
      input: "transcoder.html",
    },
  },
  // A cache of its own, apart from the main window's dev server (see vite.renderer.config.mts).
  cacheDir: "node_modules/.vite/transcoder",
  optimizeDeps: { entries: ["transcoder.html"] },
  resolve: {
    preserveSymlinks: false,
  },
});
