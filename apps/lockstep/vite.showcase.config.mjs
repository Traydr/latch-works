import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5200,
  },
  build: {
    outDir: path.join(rootDir, ".showcase-preview"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(rootDir, "showcase-preview.html"),
    },
  },
});
