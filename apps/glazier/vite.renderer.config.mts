import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The transcoder's dev server runs beside this one with another config. Sharing Vite's default
  // cache, each start one of them re-optimized the dependencies the other was loading, and the
  // window that lost came up blank (504 Outdated Optimize Dep) every other `pnpm start`.
  cacheDir: "node_modules/.vite/main_window",
  optimizeDeps: { entries: ["index.html"] },
  plugins: [react()],
  resolve: {
    // Forge's renderer defaults preserve symlinks, which hides react-dom's own `scheduler` from
    // Rolldown under pnpm's isolated layout. Resolving real paths finds it where pnpm put it.
    preserveSymlinks: false,
  },
});
