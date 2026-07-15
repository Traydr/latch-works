import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  mkdir(resolve(dist, "sidepanel"), { recursive: true }),
  mkdir(resolve(dist, "options"), { recursive: true }),
  mkdir(resolve(dist, "background"), { recursive: true }),
  mkdir(resolve(dist, "offscreen"), { recursive: true }),
  mkdir(resolve(dist, "ui"), { recursive: true })
]);

await Promise.all([
  cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(root, "assets"), resolve(dist, "assets"), { recursive: true }),
  cp(resolve(root, "rules"), resolve(dist, "rules"), { recursive: true }),
  cp(resolve(root, "ui", "gather-box.css"), resolve(dist, "ui", "gather-box.css")),
  cp(resolve(root, "sidepanel", "sidepanel.html"), resolve(dist, "sidepanel", "sidepanel.html")),
  cp(resolve(root, "sidepanel", "sidepanel.css"), resolve(dist, "sidepanel", "sidepanel.css")),
  cp(resolve(root, "options", "options.html"), resolve(dist, "options", "options.html")),
  cp(resolve(root, "options", "options.css"), resolve(dist, "options", "options.css")),
  cp(resolve(root, "offscreen", "offscreen.html"), resolve(dist, "offscreen", "offscreen.html"))
]);

await build({
  entryPoints: {
    "sidepanel/sidepanel": resolve(root, "src", "sidepanel", "index.ts"),
    "options/options": resolve(root, "src", "options", "index.ts"),
    "background/service-worker": resolve(root, "src", "background", "index.ts"),
    "offscreen/offscreen": resolve(root, "src", "offscreen", "index.ts"),
    "content/gallery-collector": resolve(root, "src", "content", "index.ts")
  },
  bundle: true,
  format: "iife",
  outdir: dist,
  target: "chrome120",
  logLevel: "info"
});
