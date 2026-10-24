import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Forge's renderer defaults preserve symlinks, which hides react-dom's own `scheduler` from
    // Rolldown under pnpm's isolated layout. Resolving real paths finds it where pnpm put it.
    preserveSymlinks: false,
  },
});
