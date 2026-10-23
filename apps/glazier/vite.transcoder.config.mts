import { defineConfig } from "vite";

/** The hidden window that runs Mediabunny over WebCodecs; it has a page of its own. */
export default defineConfig({
  build: {
    rollupOptions: {
      input: "transcoder.html",
    },
  },
  resolve: {
    preserveSymlinks: false,
  },
});
