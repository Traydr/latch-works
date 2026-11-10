type ProductKind = "app" | "tool";

type ProductScreenshot = {
  src: string;
  alt: string;
  caption?: string;
};

type ProductFeature = {
  title: string;
  description: string;
  icon: string;
};

/** One of a product's modes, when the product is split into several (Oriel). */
type ProductMode = {
  name: string;
  kicker: string;
  tagline: string;
  description: string;
  points: string[];
  screenshot: ProductScreenshot;
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
  modes?: ProductMode[];
  features: ProductFeature[];
  highlights: string[];
};

const pipelineSlugs = ["gather-box", "oriel", "pane-view"] as const;

export type PipelineSlug = (typeof pipelineSlugs)[number];

type PipelineStep = {
  step: string;
  product: string;
  slug: PipelineSlug;
  description: string;
};

/** The four steps of the archive pipeline. Oriel covers two of them. */
export const pipeline = [
  {
    step: "Gather",
    product: "Gather Box",
    slug: "gather-box",
    description: "Collect source media from supported pages",
  },
  {
    step: "Organize",
    product: "Oriel",
    slug: "oriel",
    description: "View and tidy the archive on disk",
  },
  {
    step: "Sync",
    product: "Oriel",
    slug: "oriel",
    description: "Plan and push archive changes explicitly",
  },
  {
    step: "View",
    product: "Pane View",
    slug: "pane-view",
    description: "Browse privately on web and mobile",
  },
] as const satisfies readonly PipelineStep[];

/** The pipeline steps a product covers, as one label: "Organize · Sync" for Oriel. */
export function pipelineStepsFor(slug: PipelineSlug): string {
  return pipeline.flatMap((item) => (item.slug === slug ? [item.step] : [])).join(" · ");
}

/** Accent colour each product's chrome uses, keyed by slug. */
export const productEnamel = {
  "gather-box": "#F5A623",
  oriel: "#8B7CF6",
  "pane-view": "#38A8E8",
} satisfies Record<PipelineSlug, string>;

const products: Product[] = [
  {
    slug: "gather-box",
    name: "Gather Box",
    kind: "app",
    tagline: "Collect first. Organize later.",
    description:
      "Gather Box is a Chrome extension that downloads images, videos, and story PDFs from supported sites into inferred local folder structures, ready for Oriel to view, tidy, and sync.",
    repoPath: "apps/gather-box",
    heroScreenshot: {
      src: "/screenshots/gather-box/sidepanel-active.png",
      alt: "Gather Box side panel on a supported page, with the profile picker, the chosen folder, and the save destination",
      caption: "Side panel with page detection, profile and folder selection, and save destination",
    },
    homeScreenshot: {
      src: "/screenshots/gather-box/sidepanel-in-browser.png",
      alt: "Chrome window with an Archive of Our Own work open and the Gather Box side panel docked on the right",
      caption: "Side panel docked beside an AO3 work, ready to save",
    },
    gallery: [
      {
        src: "/screenshots/gather-box/sidepanel.png",
        alt: "Gather Box side panel prompting to open a supported page and choose a writable folder",
        caption: "The side panel flags unsupported pages and lists supported sites",
      },
    ],
    features: [
      {
        title: "Site collectors",
        // Gather Box's `source-catalog.test.ts` checks this list against the catalog.
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
        title: "Profiles and folders",
        description:
          "Pick a folder once per site, or use one global folder. Profiles keep separate sets of remembered folders, and Gather Box validates the active tab and folder before starting.",
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
      "Folder shapes that Oriel and Pane View browse the same way",
      "The first step: collect locally, organize next",
    ],
  },
  {
    slug: "oriel",
    name: "Oriel",
    kind: "app",
    tagline: "View, tidy and sync, in one window.",
    description:
      "Oriel is the native desktop app for your local archive, written in Rust on GPUI. View browses folders of images and video and reads comics. Tidy finds duplicates, converts to AVIF and MP4, cleans up junk, and shrinks video, holding every change so it can be undone. Sync plans a diff against Pane View and pushes only when you say so.",
    repoPath: "apps/oriel",
    heroScreenshot: {
      src: "/screenshots/oriel/view-gallery.png",
      alt: "Oriel in View mode: a sidebar with the View, Tidy and Sync switcher and a folder list, and a grid of eighteen thumbnails with a floating toolbar",
      caption:
        "View: one grid for images and video, with Open, Folders, Recursive, Comic, sort and Refresh in the toolbar",
    },
    gallery: [
      {
        src: "/screenshots/oriel/view-settings.png",
        alt: "Oriel's Settings page open at the View section, with Gallery and Viewer toggles and a thumbnail size slider",
        caption: "Settings, View section: gallery, viewer, and storage",
      },
      {
        src: "/screenshots/oriel/sync-push.png",
        alt: "Oriel in Sync mode after a push: every row ticked, with a run panel reading Push complete, 24 of 24 pushed, and a throughput chart",
        caption:
          "A finished push: the run panel reports bytes, throughput, pushed and failed counts",
      },
    ],
    modes: [
      {
        name: "View",
        kicker: "Browse",
        tagline: "Open a folder. Browse it as a gallery.",
        description:
          "View shows a folder's images, GIFs, and videos as one grid. Recursive flattens the subfolders into it, and Comic groups image folders into comics with a vertical reader. Double-click into the viewer for previous and next, a video player, fullscreen, and Reveal in folder.",
        points: [
          "Sort A-Z, Z-A, Newest, Oldest, or Random with Shuffle",
          "Video tiles play on hover; the viewer plays through libmpv",
          "Keyboard first: WASD and arrows, Q and E, Shift+W for the parent folder",
          "Never writes into the folder it shows",
        ],
        screenshot: {
          src: "/screenshots/oriel/view-viewer.png",
          alt: "Oriel's viewer showing a red sample image, with copy path, reveal, show in Tidy, fullscreen and close buttons and arrows at both sides",
          caption:
            "The viewer: previous and next, Copy path, Reveal in folder, Show in Tidy, Fullscreen",
        },
      },
      {
        name: "Tidy",
        kicker: "Organize",
        tagline: "Find what to fix. Hold it, don't delete it.",
        description:
          "Add a folder and Tidy scans it: identical copies and similar versions, files to convert to AVIF and MP4, junk, empty folders, wrong extensions, silent soundtracks, and videos AV1 would shrink. Tidy up runs the safe changes at once. Duplicates and Shrink wait for your eye.",
        points: [
          "Everything goes to Holding first and has an Undo; History lists every change",
          "Duplicates: Strict, Balanced, or Loose matching, with the reason each keeper wins",
          "Convert keeps a result only when it is at least 5% smaller",
          "Library lists every file with filters, Quick Look, Rename, and Move to…",
        ],
        screenshot: {
          src: "/screenshots/oriel/tidy-overview.png",
          alt: "Oriel in Tidy mode on its Overview page: a card saying tidying up saves about 690 KB with a Tidy up button, a Convert to AVIF and MP4 row, and a sidebar listing Duplicates, Convert, Clean up, Shrink, Library, History and Holding",
          caption:
            "Tidy's Overview: what tidying up saves, with Duplicates, Convert, Clean up, Shrink, Library, History, and Holding",
        },
      },
      {
        name: "Sync",
        kicker: "Sync",
        tagline: "Plan, then push. Prune only on purpose.",
        description:
          "A profile pairs an archive folder with a Pane View server. Plan compares the two and lists uploads, updates, and deletes without touching the server. Push uploads and registers originals, hashing as it goes, and never deletes. Prune removes the deletes from the plan you reviewed, once you confirm.",
        points: [
          "Re-plan whenever folders change; filter the plan tree by path",
          "A run panel with throughput, pushed and failed counts, and Retry failed",
          "Check connection tests the source folder, URL, token, and snapshot",
          "Tokens are saved encrypted in Oriel's data folder; the Lockstep CLI covers scripted runs",
        ],
        screenshot: {
          src: "/screenshots/oriel/sync-plan.png",
          alt: "Oriel in Sync mode with a plan: 24 files to upload under sfw/, 18 of them in photos/, a Filter paths box, Re-plan and Push buttons, and a footer reading 0 unchanged, 1 skipped",
          caption: "A plan: 24 to upload, nothing changes on the server until Push",
        },
      },
    ],
    features: [
      {
        title: "Mixed media gallery",
        description:
          "Images, GIFs, and videos share one grid, and video tiles play on hover. Comic mode turns image folders into comics with a vertical reader.",
        icon: "film",
      },
      {
        title: "Native and fast",
        description:
          "Rust on GPUI with a local thumbnail cache. Video plays through libmpv, so MKV, WebM, and AV1 work as well as MP4.",
        icon: "zap",
      },
      {
        title: "Duplicates you decide",
        description:
          "Identical copies and similar versions in a review queue, with a loupe, Spot variants, and the reason Tidy prefers one copy. You keep the one you want.",
        icon: "copy",
      },
      {
        title: "Convert, clean up, shrink",
        description:
          "AVIF for stills, MP4 for animations and video, AV1 to shrink. Clean up moves junk to Holding, removes empty folders, and fixes wrong extensions.",
        icon: "wand",
      },
      {
        title: "Holding and Undo",
        description:
          "Tidy moves files to Holding instead of deleting them. Every change has an Undo, History lists them all, and Empty to Trash is your call.",
        icon: "archive",
      },
      {
        title: "Explicit sync",
        description:
          "Plan is read-only. Push uploads and updates only. Prune is a separate action, unlocked by the plan you reviewed and confirmed before it deletes.",
        icon: "upload",
      },
    ],
    highlights: [
      "One native app for View, Tidy, and Sync",
      "Tidy holds every change and can undo it",
      "Push never deletes; Prune is separate and reviewed",
      "The desktop browsing Pane View mirrors on the web",
    ],
  },
  {
    slug: "pane-view",
    name: "Pane View",
    kind: "app",
    tagline: "Your archive through a private pane.",
    description:
      "Pane View brings Oriel's desktop browsing to the web with authenticated access to synced media. Browse folders, comics, and stories on desktop, iPad, and iPhone.",
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
        title: "Desktop parity",
        description:
          "Folder grid, comic mode, sort modes, and keyboard-first navigation mirror Oriel's View mode on the desktop.",
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
          "Oriel's Sync mode or the Lockstep CLI uploads and registers originals on purpose; Pane View indexes what arrives. Nothing mirrors automatically.",
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
