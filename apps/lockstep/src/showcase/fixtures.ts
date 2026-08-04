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

export const showcasePlan: LockstepPlan = {
  counts: {
    delete: 2,
    keep: 1842,
    update: 5,
    upload: 12,
  },
  items: showcasePlanItems(),
  skipped: 3,
  skippedEntries: [{ path: "sfw/.DS_Store", reason: "not media" }],
  sourceRoot: "/Volumes/Media/archive",
  totalBytes: 1_842_000_000,
  totalFiles: 1866,
};

function showcasePlanItems(): LockstepPlanItem[] {
  return [
    { action: "upload", path: "sfw/photos/sample-14.jpg" },
    { action: "upload", path: "sfw/photos/sample-15.jpg" },
    { action: "upload", path: "sfw/comics/chapter-01/001.webp" },
    { action: "update", path: "sfw/photos/sample-03.jpg" },
    { action: "update", path: "sfw/stories/author-long_title.pdf" },
    { action: "delete", path: "sfw/photos/retired/sample-old.jpg" },
    { action: "delete", path: "sfw/comics/dropped-series/page-04.webp" },
  ];
}
