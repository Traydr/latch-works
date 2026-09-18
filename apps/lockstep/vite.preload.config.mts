import { defineConfig, type Plugin } from "vite";

/**
 * Forge's preload defaults still set Rollup's `inlineDynamicImports`, which Rolldown (Vite 8) has
 * deprecated in favour of `codeSplitting: false`. Vite's config merge cannot unset a key, so this
 * plugin drops it after the merge; a preload script stays one file either way.
 */
function singleFilePreload(): Plugin {
  return {
    name: "lockstep:single-file-preload",
    outputOptions(options) {
      const { inlineDynamicImports: _ignored, ...rest } = options;

      return { ...rest, codeSplitting: false };
    },
  };
}

export default defineConfig({
  plugins: [singleFilePreload()],
});
