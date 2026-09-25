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
  slug: PipelineSlug;
  name: string;
  kind: ProductKind;
  tagline: string;
  description: string;
  repoPath: string;
  heroScreenshot: ProductScreenshot;
  /** Shown on the home plate instead of the hero when the hero is not a landscape. */
  homeScreenshot?: ProductScreenshot;
  gallery: ProductScreenshot[];
  features: ProductFeature[];
  highlights: string[];
};

export const pipeline = [
  {
    step: "Gather",
    product: "Gather Box",
    description: "Collect source media from supported pages",
  },
  { step: "Organize", product: "Frame View", description: "Browse and verify locally on desktop" },
  { step: "Sync", product: "Lockstep", description: "Plan and push archive changes explicitly" },
  { step: "View", product: "Pane View", description: "Browse privately on web and mobile" },
] as const;

export const pipelineSlugs = ["gather-box", "frame-view", "lockstep", "pane-view"] as const;

export type PipelineSlug = (typeof pipelineSlugs)[number];

/** Accent colour each product's chrome uses, keyed by slug. */
export const productEnamel = {
  "gather-box": "#F5A623",
  "frame-view": "#8B7CF6",
  lockstep: "#34C98E",
  "pane-view": "#38A8E8",
} satisfies Record<PipelineSlug, string>;

export const products: Product[] = [
  {
    slug: "gather-box",
    name: "Gather Box",
    kind: "app",
    tagline: "Collect first. Organize later.",
    description:
      "Gather Box is a Chrome extension that downloads images, videos, and story PDFs from supported sites into inferred local folder structures, ready for Frame View browsing and Lockstep sync.",
    repoPath: "apps/gather-box",
    heroScreenshot: {
      src: "/screenshots/gather-box/sidepanel-active.png",
      alt: "Gather Box side panel on a supported page, showing the save destination",
      caption: "Side panel with page detection, folder selection, and save destination",
    },
    homeScreenshot: {
      src: "/screenshots/gather-box/sidepanel-in-browser.png",
      alt: "Chrome window with an Archive of Our Own work open and the Gather Box side panel docked on the right",
      caption: "Side panel docked beside an AO3 work, ready to save",
    },
    gallery: [
      {
        src: "/screenshots/gather-box/sidepanel.png",
        alt: "Gather Box side panel prompting to open a supported page",
        caption: "The side panel flags unsupported pages and lists supported sites",
      },
    ],
    features: [
      {
        title: "Site collectors",
        description:
          "Dedicated collectors for X, Reddit, pixiv, Archive of Our Own, and FanFiction.Net.",
        icon: "globe",
      },
      {
        title: "Smart folder inference",
        description:
          "Downloads land in structured paths that match how you will browse them later, with creator and post naming included.",
        icon: "folder-input",
      },
      {
        title: "Gallery & story support",
        description:
          "Media keeps its original filenames (Reddit galleries get order prefixes); long-form stories save as PDF for offline reading.",
        icon: "images",
      },
      {
        title: "Progress feedback",
        description:
          "Live progress bar, page status checks, and a run log so you know exactly what was saved.",
        icon: "activity",
      },
      {
        title: "Writable folder picker",
        description:
          "Pick a folder once per site, or use one global folder. Gather Box validates the active tab and folder before starting.",
        icon: "hard-drive",
      },
      {
        title: "Archive pipeline entry point",
        description:
          "Collected media flows into the local archive: the first step in Gather → Organize → Sync → View.",
        icon: "workflow",
      },
    ],
    highlights: [
      "Chrome extension for supported gallery and story sites",
      "Galleries and PDF stories land in browseable folders",
      "Folder shapes that match Frame View and Lockstep",
      "The first step: collect locally, organize next",
    ],
  },
  {
    slug: "frame-view",
    name: "Frame View",
    kind: "app",
    tagline: "Your local archive, framed.",
    description:
      "Frame View is the cross-platform desktop gallery for local image, video, and comic archives. Pane View mirrors the same browsing patterns on the web (and adds PDF reading after sync).",
    repoPath: "apps/frame-view",
    heroScreenshot: {
      src: "/screenshots/frame-view/gallery.png",
      alt: "Frame View desktop gallery grid with folder header and toolbar",
      caption: "Virtualized gallery with folder navigation and a floating toolbar",
    },
    gallery: [
      {
        src: "/screenshots/frame-view/viewer.png",
        alt: "Frame View media viewer showing an image",
        caption: "Viewer with previous/next, fullscreen, and reveal-in-folder controls",
      },
      {
        src: "/screenshots/frame-view/settings.png",
        alt: "Frame View settings drawer",
        caption: "Preferences for theme, playback, and what the grid shows",
      },
    ],
    features: [
      {
        title: "Mixed media gallery",
        description:
          "Images and videos share one grid. Video tiles play on hover so you can scan motion at a glance.",
        icon: "film",
      },
      {
        title: "Virtualized rendering",
        description:
          "Large folders stay responsive thanks to virtualized grids and a local media index with thumbnail cache.",
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
          "Recursive scanning, a subfolder browser, sibling-folder jumps, and remembered last-opened paths.",
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
          "WASD and arrow keys, folder jumps, video hotkeys, and sort modes including random shuffle.",
        icon: "keyboard",
      },
    ],
    highlights: [
      "Desktop gallery for images, video, and comics",
      "Fast browsing in large local folders",
      "Dark and light themes with remembered window state",
      "The local browsing experience Pane View mirrors on the web",
    ],
  },
  {
    slug: "lockstep",
    name: "Lockstep",
    kind: "tool",
    tagline: "Plan, push, verify.",
    description:
      "Lockstep is the desktop sync client for your local archive. Scan against Pane View, review a read-only plan, push uploads and updates explicitly, and prune remote deletes only when you choose.",
    repoPath: "apps/lockstep",
    heroScreenshot: {
      src: "/screenshots/lockstep/plan.png",
      alt: "Lockstep desktop plan results with upload, update, and delete counts",
      caption: "Read-only plan: review changes before any writes",
    },
    gallery: [
      {
        src: "/screenshots/lockstep/push.png",
        alt: "Lockstep desktop push progress with run log",
        caption: "Push uploads and updates; deletes stay on a separate Prune action",
      },
    ],
    features: [
      {
        title: "Plan Changes",
        description:
          "Walk the source tree, diff against Pane View, and review upload, update, keep, and delete counts with zero side effects.",
        icon: "list-checks",
      },
      {
        title: "Push Updates",
        description:
          "Upload and register new or changed originals. Push never applies deletes; those stay on a separate Prune action.",
        icon: "upload",
      },
      {
        title: "Prune",
        description:
          "Remove remote entries that no longer exist locally, only when you run this action and confirm.",
        icon: "trash-2",
      },
      {
        title: "Verify",
        description:
          "The CLI compares local archive state against a snapshot file and exits non-zero on drift.",
        icon: "git-compare",
      },
      {
        title: "Doctor",
        description:
          "Check the source folder, sync token, and Pane View reachability before a long run.",
        icon: "stethoscope",
      },
      {
        title: "Profiles",
        description:
          "Save, edit, and switch profiles with a source folder, Pane View URL, and sync token each. Tokens are encrypted by the OS when available.",
        icon: "user-cog",
      },
    ],
    highlights: [
      "Review a read-only plan before you push",
      "Push never applies deletes; Prune is a separate action",
      "Content hashing on push catches same-size changes",
      "Optional CLI companion for scripted runs",
    ],
  },
  {
    slug: "pane-view",
    name: "Pane View",
    kind: "app",
    tagline: "Your archive through a private pane.",
    description:
      "Pane View brings the Frame View-style browsing experience to the web with authenticated access to synced media. Browse folders, comics, and stories on desktop, iPad, and iPhone.",
    repoPath: "apps/pane-view",
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
        caption: "Private access behind sign-in",
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
          "Thumbnails, previews, and originals load through signed, expiring links, so media never sits on a public gallery URL.",
        icon: "shield",
      },
      {
        title: "Explicit sync",
        description:
          "Lockstep uploads and registers originals on purpose; Pane View indexes what arrives. Nothing mirrors automatically.",
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
          "Image folders become comic entries; PDF stories open in a scrolling reader that remembers your place.",
        icon: "book-open",
      },
      {
        title: "Search & filters",
        description:
          "Search the whole synced archive by filename or path, toggle recursive scanning, and filter images or videos.",
        icon: "search",
      },
    ],
    highlights: [
      "Private web gallery with signed media delivery",
      "Comic mode, detail panel, and keyboard shortcuts",
      "Works on desktop, iPad, and iPhone",
      "Explicit sync: the local archive stays source of truth",
    ],
  },
];

export const pipelineProducts = pipelineSlugs.flatMap((slug) => {
  const product = products.find((candidate) => candidate.slug === slug);

  return product ? [product] : [];
});

export function getProduct(slug: string): Product | undefined {
  return products.find((product) => product.slug === slug);
}
