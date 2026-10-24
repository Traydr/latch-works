import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // A cache of its own, so a second renderer's dev server beside this one never re-optimizes the
  // dependencies this one is loading (Glazier's transcoder window came up blank that way).
  cacheDir: "node_modules/.vite/main_window",
  optimizeDeps: { entries: ["index.html"] },
  plugins: [react()],
  resolve: {
    // Forge's renderer defaults preserve symlinks, which hides react-dom's own `scheduler` from
    // Rolldown under pnpm's isolated layout. Resolving real paths finds it where pnpm put it.
    preserveSymlinks: false,
  },
});
