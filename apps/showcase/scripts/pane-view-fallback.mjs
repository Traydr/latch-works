import { join } from "node:path";

const photosDir = join(process.env.LOCKSTEP_SOURCE ?? "/tmp/showcase-archive", "sfw/photos");

function sampleImageUrl(index) {
  const fileName = `sample-${String(index).padStart(2, "0")}.jpg`;
  return `file://${join(photosDir, fileName)}`;
}

export function buildPaneViewLoginHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090b; color: #f4f4f5; font-family: "Geist Variable", "Segoe UI", system-ui, sans-serif; }
  form { width: min(100%, 24rem); display: grid; gap: 1rem; padding: 1.25rem; border-radius: 0.75rem; border: 1px solid #27272a; background: #18181b; }
  .header { display: flex; gap: 0.75rem; align-items: center; border-bottom: 1px solid #27272a; padding-bottom: 1rem; }
  .logo { width: 2.25rem; height: 2.25rem; display: grid; place-items: center; border-radius: 0.5rem; border: 1px solid #3f3f46; color: #fcd34d; font-size: 0.75rem; font-weight: 700; }
  .title { font-size: 0.875rem; font-weight: 600; }
  .subtitle { display: block; font-size: 0.75rem; color: #a1a1aa; margin-top: 0.15rem; }
  label { display: grid; gap: 0.35rem; font-size: 0.75rem; color: #a1a1aa; }
  input { width: 100%; border-radius: 0.5rem; border: 1px solid #3f3f46; background: rgba(24,24,27,.7); color: #f4f4f5; padding: 0.55rem 0.7rem; }
  button { border: 0; border-radius: 0.5rem; background: #f4f4f5; color: #18181b; padding: 0.7rem 1rem; font-weight: 600; }
</style></head><body>
  <form>
    <div class="header">
      <div class="logo">LW</div>
      <div><div class="title">Pane View</div><span class="subtitle">Private archive access</span></div>
    </div>
    <label>Username<input id="username" value="showcase" /></label>
    <label>Password<input id="password" type="password" value="showcase123" /></label>
    <button type="button">Sign in</button>
  </form>
</body></html>`;
}

export function buildPaneViewGalleryHtml() {
  const tiles = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const selected = number === 1 ? "selected" : "";
    return `<button class="tile ${selected}" type="button"><img src="${sampleImageUrl(number)}" alt="Sample ${number}" /></button>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en" class="dark"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #09090b; color: #f4f4f5; font-family: "Geist Variable", "Segoe UI", system-ui, sans-serif; }
  .shell { display: grid; grid-template-columns: 240px 1fr 320px; min-height: 100vh; }
  aside, .detail { background: #18181b; border-color: #27272a; }
  aside { border-right: 1px solid #27272a; padding: 1rem; }
  .detail { border-left: 1px solid #27272a; padding: 1rem; }
  .brand { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1.5rem; }
  .logo { width: 2rem; height: 2rem; display: grid; place-items: center; border-radius: 0.45rem; border: 1px solid #3f3f46; color: #fcd34d; font-size: 0.7rem; font-weight: 700; }
  .tree { font-size: 0.85rem; color: #d4d4d8; line-height: 1.8; }
  .tree .active { color: #c4b5fd; }
  main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.85rem 1rem; border-bottom: 1px solid #27272a; }
  .crumbs, .search { font-size: 0.8rem; color: #a1a1aa; }
  .search { flex: 1; max-width: 28rem; margin-left: auto; padding: 0.55rem 0.75rem; border-radius: 0.65rem; border: 1px solid #3f3f46; background: rgba(24,24,27,.8); color: #71717a; }
  .grid-wrap { padding: 1rem 1rem 5rem; overflow: auto; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.85rem; }
  .tile { border: 1px solid #3f3f46; border-radius: 1rem; overflow: hidden; padding: 0; background: #27272a; aspect-ratio: 4/3; cursor: pointer; }
  .tile.selected { border-color: #8b5cf6; box-shadow: 0 0 0 1px #8b5cf6; }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .toolbar { position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-35%); display: flex; gap: 0.35rem; padding: 0.45rem; border-radius: 999px; border: 1px solid #3f3f46; background: rgba(24,24,27,.92); backdrop-filter: blur(12px); }
  .toolbar span { font-size: 0.75rem; color: #e4e4e7; padding: 0.45rem 0.8rem; }
  .preview { aspect-ratio: 1; border-radius: 1rem; overflow: hidden; border: 1px solid #3f3f46; margin-bottom: 1rem; }
  .preview img { width: 100%; height: 100%; object-fit: cover; }
  .primary { display: block; width: 100%; border: 0; border-radius: 0.65rem; background: #f4f4f5; color: #18181b; padding: 0.7rem; font-weight: 600; margin-bottom: 0.75rem; }
  .meta { font-size: 0.75rem; color: #a1a1aa; display: grid; gap: 0.55rem; }
  .meta strong { color: #e4e4e7; font-weight: 500; }
</style></head><body>
  <div class="shell">
    <aside>
      <div class="brand"><div class="logo">LW</div><div><strong>Pane View</strong><div style="font-size:0.75rem;color:#a1a1aa">Latch Works</div></div></div>
      <div class="tree">Archive root<br/>└ sfw<br/>&nbsp;&nbsp;└ <span class="active">photos</span></div>
    </aside>
    <main>
      <div class="top">
        <div class="crumbs">Synced archive › sfw › photos</div>
        <div class="search">Search paths</div>
      </div>
      <div class="grid-wrap"><div class="grid">${tiles}</div></div>
      <div class="toolbar"><span>Recursive</span><span>Comic</span><span>A-Z</span><span>Shuffle</span><span>Refresh</span></div>
    </main>
    <div class="detail">
      <div class="preview"><img src="${sampleImageUrl(1)}" alt="" /></div>
      <button class="primary" type="button">Open Viewer</button>
      <div class="meta">
        <div><strong>Name</strong><br/>sample-01.jpg</div>
        <div><strong>Path</strong><br/>sfw/photos/sample-01.jpg</div>
        <div><strong>Type</strong><br/>image</div>
      </div>
    </div>
  </div>
</body></html>`;
}

export function buildPaneViewViewerHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="dark"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: rgba(9,9,11,.96); color: #f4f4f5; font-family: "Geist Variable", "Segoe UI", system-ui, sans-serif; min-height: 100vh; }
  .modal { position: fixed; inset: 0; display: grid; grid-template-rows: auto 1fr; }
  .bar { display: flex; justify-content: space-between; align-items: center; padding: 0.85rem 1rem; border-bottom: 1px solid #27272a; }
  .meta { font-size: 0.8rem; color: #a1a1aa; }
  .actions { display: flex; gap: 0.5rem; }
  .actions button { border: 1px solid #3f3f46; background: rgba(24,24,27,.8); color: #e4e4e7; border-radius: 0.75rem; padding: 0.45rem 0.8rem; font-size: 0.75rem; }
  .stage { display: grid; place-items: center; padding: 2rem; }
  .stage img { max-width: min(80vw, 1100px); max-height: 72vh; border-radius: 0.75rem; border: 1px solid #3f3f46; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
</style></head><body>
  <div class="modal">
    <div class="bar">
      <div class="meta">sample-01.jpg · 234 KB · JPG · 1600×1200 · 1 / 12</div>
      <div class="actions"><button type="button">Copy path</button><button type="button">Download</button><button type="button">Close</button></div>
    </div>
    <div class="stage"><img src="${sampleImageUrl(1)}" alt="" /></div>
  </div>
</body></html>`;
}

export function writePaneViewFallbackPages(publicDir) {
  const paneDir = join(publicDir, "pane-view");
  const pages = {
    login: buildPaneViewLoginHtml(),
    gallery: buildPaneViewGalleryHtml(),
    viewer: buildPaneViewViewerHtml(),
  };

  return Object.fromEntries(
    Object.entries(pages).map(([name, html]) => {
      const htmlPath = join(paneDir, `_preview-${name}.html`);
      return [name, { html, htmlPath }];
    }),
  );
}
