/**
 * The Vitest config every workspace extends. Workspace packages resolve through their `source`
 * export condition, so tests read source and never a stale or missing `dist/`.
 */
export default {
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: { environment: "node" },
};
