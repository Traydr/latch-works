import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  mkdir(resolve(dist, "popup"), { recursive: true }),
  mkdir(resolve(dist, "sidepanel"), { recursive: true }),
  mkdir(resolve(dist, "options"), { recursive: true }),
  mkdir(resolve(dist, "background"), { recursive: true })
]);

await Promise.all([
  cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true }),
  cp(resolve(root, "popup", "popup.html"), resolve(dist, "popup", "popup.html")),
  cp(resolve(root, "popup", "popup.css"), resolve(dist, "popup", "popup.css")),
  cp(resolve(root, "popup", "layout-preview.html"), resolve(dist, "popup", "layout-preview.html")),
  cp(resolve(root, "popup", "layout-preview.js"), resolve(dist, "popup", "layout-preview.js")),
  cp(resolve(root, "sidepanel", "sidepanel.html"), resolve(dist, "sidepanel", "sidepanel.html")),
  cp(resolve(root, "sidepanel", "sidepanel.css"), resolve(dist, "sidepanel", "sidepanel.css")),
  cp(resolve(root, "options", "options.html"), resolve(dist, "options", "options.html")),
  cp(resolve(root, "options", "options.css"), resolve(dist, "options", "options.css"))
]);

await build({
  entryPoints: {
    "popup/popup": resolve(root, "src", "popup", "index.ts"),
    "sidepanel/sidepanel": resolve(root, "src", "sidepanel", "index.ts"),
    "options/options": resolve(root, "src", "options", "index.ts"),
    "background/service-worker": resolve(root, "src", "background", "index.ts"),
    "content/gallery-collector": resolve(root, "src", "content", "index.ts")
  },
  bundle: true,
  format: "iife",
  outdir: dist,
  target: "chrome120",
  logLevel: "info"
});
