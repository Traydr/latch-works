import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await mkdir(resolve(dist, "popup"), { recursive: true });

await Promise.all([
  cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true }),
  cp(resolve(root, "popup", "popup.html"), resolve(dist, "popup", "popup.html")),
  cp(resolve(root, "popup", "popup.css"), resolve(dist, "popup", "popup.css"))
]);

await build({
  entryPoints: {
    "popup/popup": resolve(root, "src", "popup", "index.ts"),
    "content/gallery-collector": resolve(root, "src", "content", "index.ts")
  },
  bundle: true,
  format: "iife",
  outdir: dist,
  target: "chrome120",
  logLevel: "info"
});
