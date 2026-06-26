import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { showcaseLivePushPlugin } from "./src/showcase/livePushPlugin.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(rootDir, "../.."), "");
  Object.assign(process.env, env);

  return {
    root: rootDir,
    plugins: [react(), showcaseLivePushPlugin()],
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
  };
});
