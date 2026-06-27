import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// react-dom's transitive dep `scheduler` is not always hoisted to the top
// level by pnpm's hoisted linker in the local workspace. Resolve it from
// react-dom's actual store location so Vite's optimizer can inline it.
function resolveSchedulerAlias(): Record<string, string> | undefined {
  try {
    const reactDomEntry = require.resolve("react-dom");
    const schedulerEntry = require.resolve("scheduler", {
      paths: [path.dirname(reactDomEntry)],
    });
    return { scheduler: path.dirname(schedulerEntry) };
  } catch {
    return undefined;
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: resolveSchedulerAlias(),
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  },
});
