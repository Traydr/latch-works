export type ProductKind = "app" | "tool";

export type ProductScreenshot = {
  src: string;
  alt: string;
  caption?: string;
};

export type ProductFeature = {
  title: string;
  description: string;
  icon: string;
};

export type Product = {
  slug: string;
  name: string;
  kind: ProductKind;
  tagline: string;
  description: string;
  repoPath: string;
  accent: string;
  heroScreenshot: ProductScreenshot;
  gallery: ProductScreenshot[];
  features: ProductFeature[];
  highlights: string[];
};

export const pipeline = [
  { step: "Gather", product: "Gather Box", description: "Collect source media from supported pages" },
  { step: "Organize", product: "Frame View", description: "Browse and verify locally on desktop" },
  { step: "Sync", product: "Lockstep", description: "Plan and push archive changes explicitly" },
  { step: "View", product: "Pane View", description: "Browse privately on web and mobile" },
] as const;

export const products: Product[] = [
  {
    slug: "pane-view",
    name: "Pane View",
    kind: "app",
    tagline: "Your archive through a private pane.",
    description:
      "Pane View brings the Frame View-style browsing experience to the web with authenticated, read-only access to synced media. Browse folders, comics, and stories on desktop, iPad, and iPhone.",
    repoPath: "apps/pane-view",
    accent: "from-sky-500/20 to-cyan-500/5",
    heroScreenshot: {
      src: "/screenshots/pane-view/gallery.png",
      alt: "Pane View gallery with folder sidebar and media grid",
      caption: "Authenticated gallery with folder navigation and detail panel",
    },
    gallery: [
      {
        src: "/screenshots/pane-view/viewer.png",
        alt: "Pane View fullscreen media viewer",
        caption: "Fullscreen viewer with keyboard navigation",
      },
      {
        src: "/screenshots/pane-view/login.png",
        alt: "Pane View login screen",
        caption: "Private access — read-only by default",
      },
    ],
    features: [
      {
        title: "Frame View parity",
        description:
          "Folder grid, comic mode, sort modes, and keyboard-first navigation mirror the desktop reference experience.",
        icon: "layout-grid",
      },
      {
        title: "Authenticated delivery",
        description:
          "Thumbnails and previews resolve through signed CDN tokens — media never sits on a public gallery URL.",
        icon: "shield",
      },
      {
        title: "Sync API integration",
        description:
          "Lockstep pushes originals and snapshots through dedicated sync routes; Pane View indexes what arrives.",
        icon: "refresh-cw",
      },
      {
        title: "Responsive layout",
        description:
          "Sidebar collapses on mobile, floating toolbar adapts, and touch targets stay comfortable on iPad and iPhone.",
        icon: "smartphone",
      },
      {
        title: "Comic & story reading",
        description:
          "Image folders become comic entries; PDF stories open in a dedicated reader with page navigation.",
        icon: "book-open",
      },
      {
        title: "Search & filters",
        description:
          "Query across the synced archive, toggle recursive folder scanning, and jump directly to matching media.",
        icon: "search",
      },
    ],
    highlights: [
      "TanStack Start + PostgreSQL + S3-compatible storage",
      "Signed thumbnail and preview delivery",
      "Comic mode, detail panel, and hotkey overlay",
      "Explicit sync — local archive stays source of truth",
    ],
  },
  {
    slug: "frame-view",
    name: "Frame View",
    kind: "app",
    tagline: "Your local archive, framed.",
    description:
      "Frame View is the cross-platform Electron desktop gallery for local image, video, comic, and PDF story archives. It is the UX north star for the entire Latch Works ecosystem.",
    repoPath: "apps/frame-view",
    accent: "from-violet-500/20 to-purple-500/5",
    heroScreenshot: {
      src: "/screenshots/frame-view/gallery.png",
      alt: "Frame View desktop gallery with mixed media grid",
      caption: "Virtualized gallery with mixed images and looping video thumbnails",
    },
    gallery: [
      {
        src: "/screenshots/frame-view/viewer.png",
        alt: "Frame View fullscreen media viewer with video controls",
        caption: "Fullscreen viewer with seek, speed, and volume controls",
      },
      {
        src: "/screenshots/frame-view/settings.png",
        alt: "Frame View settings drawer",
        caption: "Persistent settings for theme, hotkeys, and storage paths",
      },
    ],
    features: [
      {
        title: "Mixed media gallery",
        description:
          "Images and videos share one grid. Video thumbnails autoplay and loop so you can scan motion at a glance.",
        icon: "film",
      },
      {
        title: "Virtualized rendering",
        description:
          "Large folders stay responsive thanks to virtualized grids and a SQLite-backed media index with thumbnail cache.",
        icon: "zap",
      },
      {
        title: "Comic mode",
        description:
          "Folders of sequential images collapse into comic entries with a dedicated reader and keyboard page turns.",
        icon: "book-open",
      },
      {
        title: "Folder navigation",
        description:
          "Recursive scanning, folder overlay, breadcrumb navigation, and remembered last-opened paths.",
        icon: "folder-tree",
      },
      {
        title: "Rich video controls",
        description:
          "Seek bar, skip intervals, playback speed, temporary speed boost, volume, and fullscreen in the viewer modal.",
        icon: "play",
      },
      {
        title: "Keyboard-first",
        description:
          "Arrow keys, double-click to viewer, configurable hotkeys, and sort modes including random shuffle.",
        icon: "keyboard",
      },
    ],
    highlights: [
      "Electron + Vite + React + Tailwind",
      "SQLite media index and workerized thumbnails",
      "Dark and light themes with persistent window state",
      "Reference UX that Pane View targets for parity",
    ],
  },
  {
    slug: "gather-box",
    name: "Gather Box",
    kind: "app",
    tagline: "Collect first. Organize later.",
    description:
      "Gather Box is a Chrome extension that downloads image galleries and story PDFs from supported sites into inferred local folder structures — ready for Frame View browsing and Lockstep sync.",
    repoPath: "apps/gather-box",
    accent: "from-amber-500/20 to-orange-500/5",
    heroScreenshot: {
      src: "/screenshots/gather-box/popup.png",
      alt: "Gather Box extension popup ready to download",
      caption: "Extension popup with page detection and folder selection",
    },
    gallery: [
      {
        src: "/screenshots/gather-box/popup-active.png",
        alt: "Gather Box popup showing supported page status",
        caption: "Site-specific collectors detect supported gallery pages",
      },
    ],
    features: [
      {
        title: "Site collectors",
        description:
          "Dedicated content scripts for Fanbox, Kemono, Archive of Our Own, Fanfiction.net, Hentai Foundry, and more.",
        icon: "globe",
      },
      {
        title: "Smart folder inference",
        description:
          "Downloads land in structured paths that match how you will browse them later — artist, series, and post naming included.",
        icon: "folder-input",
      },
      {
        title: "Gallery & story support",
        description:
          "Image galleries download as numbered sequences; long-form stories export to PDF for offline reading.",
        icon: "images",
      },
      {
        title: "Progress feedback",
        description:
          "Live progress bar, page status checks, and a results log so you know exactly what was saved.",
        icon: "activity",
      },
      {
        title: "Writable folder picker",
        description:
          "Choose a destination folder per run. Gather Box validates the active tab and folder before starting.",
        icon: "hard-drive",
      },
      {
        title: "Archive pipeline entry point",
        description:
          "Collected media flows into the local archive — the first step in Gather → Organize → Sync → View.",
        icon: "workflow",
      },
    ],
    highlights: [
      "Chrome extension built with TypeScript and esbuild",
      "Multi-site gallery and PDF story collectors",
      "Inferred folder structures for downstream viewers",
      "Pairs with Frame View locally and Lockstep for remote sync",
    ],
  },
  {
    slug: "lockstep",
    name: "Lockstep",
    kind: "tool",
    tagline: "Plan, push, verify.",
    description:
      "Lockstep is the desktop sync client for your local archive. Scan against Pane View, review a read-only plan, push uploads and updates explicitly, and apply deletes only when you choose.",
    repoPath: "apps/lockstep",
    accent: "from-emerald-500/20 to-teal-500/5",
    heroScreenshot: {
      src: "/screenshots/lockstep/plan.png",
      alt: "Lockstep desktop plan results with upload, update, and delete counts",
      caption: "Read-only plan — review changes before any writes",
    },
    gallery: [
      {
        src: "/screenshots/lockstep/push.png",
        alt: "Lockstep desktop push progress with run log",
        caption: "Push uploads and updates — deletes stay on a separate action",
      },
    ],
    features: [
      {
        title: "Plan (read-only)",
        description:
          "Walk the source tree, diff against Pane View, and review upload, update, keep, and delete counts with zero side effects.",
        icon: "list-checks",
      },
      {
        title: "Push uploads/updates",
        description:
          "Upload and register new or changed originals. Push never applies deletes — those stay on a separate explicit action.",
        icon: "upload",
      },
      {
        title: "Apply deletes",
        description:
          "Remove remote entries listed in the plan only when you run this action after review.",
        icon: "trash-2",
      },
      {
        title: "Verify",
        description:
          "Compare local archive state against a snapshot file and exit non-zero on drift.",
        icon: "git-compare",
      },
      {
        title: "Test connection",
        description:
          "Validate profile settings, sync token, and Pane View reachability before a long run.",
        icon: "stethoscope",
      },
      {
        title: "Profiles",
        description:
          "Save source folder, Pane View URL, and encrypted sync tokens per archive. Switch profiles when you maintain multiple libraries.",
        icon: "user-cog",
      },
    ],
    highlights: [
      "Desktop app with plan review, push progress, and run logs",
      "Push never applies deletes — Apply deletes is separate",
      "Content hashing for accurate change detection",
      "Optional command-line companion for scripted runs",
    ],
  },
];

export function getProduct(slug: string): Product | undefined {
  return products.find((product) => product.slug === slug);
}

export const apps = products.filter((product) => product.kind === "app");
export const tools = products.filter((product) => product.kind === "tool");
