export const principles = [
  {
    title: "Local-first",
    body: "The archive on disk stays authoritative. Sync is explicit, never automatic mirroring.",
  },
  {
    title: "Private by default",
    body: "Web viewing requires authentication. Delivery URLs are signed and time-limited.",
  },
  {
    title: "Shared packages",
    body: "media-domain, media-index, media-storage, and media-delivery keep behavior consistent.",
  },
  {
    title: "Calm tooling",
    body: "Direct language, dark UI, practical spacing — a workshop, not a marketing site.",
  },
] as const;

export const heroCopy = {
  eyebrow: "Private media archive ecosystem",
  title: "Collect, sync, and view your archive — privately.",
  description:
    "Latch Works brings together a browser extension, desktop viewer, sync CLI, and web viewer into one calm, local-first system. Your laptop stays the source of truth; remote access is explicit and authenticated.",
} as const;
