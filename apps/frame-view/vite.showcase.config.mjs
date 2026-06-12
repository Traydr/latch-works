import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  publicDir: path.join(rootDir, "showcase-media"),
  server: {
    host: "127.0.0.1",
    port: 5199,
    fs: {
      allow: [rootDir, path.join(rootDir, "showcase-media")],
    },
  },
  build: {
    outDir: path.join(rootDir, ".showcase-preview"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(rootDir, "showcase-preview.html"),
    },
  },
});
