import type { LockstepPlan, LockstepPlanItem, LockstepSettings } from "../shared/types";

export const showcaseSettings: LockstepSettings = {
  activeProfileId: "showcase-profile",
  profiles: [
    {
      apiUrl: "https://archive.example.com",
      id: "showcase-profile",
      lastRun: {
        action: "push",
        completedAt: "2026-06-27T00:00:00.000Z",
        failed: 0,
        pushed: 18,
        status: "completed",
      },
      name: "Main archive",
      sourceRoot: "/Volumes/Media/archive",
      tokenConfigured: true,
      tokenInSession: false,
      tokenUnreadable: false,
    },
  ],
};

const MB = 1_000_000;

export const showcasePlan: LockstepPlan = {
  counts: {
    delete: 2,
    keep: 1842,
    update: 5,
    upload: 12,
  },
  items: showcasePlanItems(),
  planId: "showcase-plan",
  skipped: 3,
  skippedEntries: [
    { path: "sfw/.DS_Store", reason: "not media" },
    { path: "sfw/photos/Thumbs.db", reason: "not media" },
    { path: "sfw/stories/draft.txt", reason: "not media" },
  ],
  sourceRoot: "/Volumes/Media/archive",
  totalBytes: 1_842_000_000,
  totalFiles: 1866,
};

function showcasePlanItems(): LockstepPlanItem[] {
  return [
    { action: "upload", path: "sfw/photos/sample-14.jpg", size: 18.2 * MB },
    { action: "upload", path: "sfw/photos/sample-15.jpg", size: 21.7 * MB },
    { action: "upload", path: "sfw/photos/2026-09-trip/IMG_0412.heic", size: 4.1 * MB },
    { action: "update", path: "sfw/photos/sample-03.jpg", size: 19.9 * MB },
    { action: "delete", path: "sfw/photos/retired/sample-old.jpg", size: 12 * MB },
    ...Array.from({ length: 8 }, (_, index) => ({
      action: "upload" as const,
      path: `sfw/comics/chapter-01/${String(index + 1).padStart(3, "0")}.webp`,
      size: (15.8 + (index % 3) * 0.3) * MB,
    })),
    { action: "delete", path: "sfw/comics/dropped-series/page-04.webp", size: 3 * MB },
    { action: "update", path: "sfw/stories/author-long_title.pdf", size: 6.2 * MB },
    { action: "update", path: "sfw/stories/anthology-2.pdf", size: 5.8 * MB },
    { action: "update", path: "sfw/stories/anthology-3.pdf", size: 5.4 * MB },
    { action: "update", path: "sfw/stories/anthology-4.pdf", size: 5.6 * MB },
    { action: "upload", path: "sfw/video/clip-2026-10-01.mp4", size: 232 * MB },
  ];
}
