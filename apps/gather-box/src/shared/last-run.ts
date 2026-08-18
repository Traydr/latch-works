import { z } from "zod";
import { SiteKeySchema } from "./source-catalog";
import { lenientArrayOf } from "./lenient-array";
import { GalleryImageSchema } from "./types";

export const DownloadFailureSchema = z.object({
  fileName: z.string(),
  reason: z.string(),
  originalUrl: z.string().optional()
});

export type DownloadFailure = z.infer<typeof DownloadFailureSchema>;

export const LastRunLogEntrySchema = z.object({
  message: z.string(),
  tone: z.enum(["error", "success"]).optional()
});

export type LastRunLogEntry = z.infer<typeof LastRunLogEntrySchema>;

export const LastRunStateSchema = z.object({
  timestamp: z.coerce.number().catch(0),
  siteKey: SiteKeySchema.nullable().catch(null),
  tabUrl: z.string().nullable().catch(null),
  destinationPreview: z.string().nullable().catch(null),
  log: lenientArrayOf(LastRunLogEntrySchema),
  failedItems: lenientArrayOf(DownloadFailureSchema),
  retryImages: lenientArrayOf(GalleryImageSchema),
  canRetry: z.boolean().catch(false)
});

export type LastRunState = z.infer<typeof LastRunStateSchema>;

const LAST_RUN_KEY = "gather-box-last-run";

export const EMPTY_LAST_RUN: LastRunState = {
  timestamp: 0,
  siteKey: null,
  tabUrl: null,
  destinationPreview: null,
  log: [],
  failedItems: [],
  retryImages: [],
  canRetry: false
};

export class LastRunWriter {
  private pending: { state: LastRunState; version: number } | null = null;
  private writing = false;
  private acceptedVersion = 0;
  private completedVersion = 0;
  private flushWaiters: Array<{ version: number; resolve: () => void }> = [];

  enqueue(state: LastRunState): void {
    this.acceptedVersion += 1;
    this.pending = { state, version: this.acceptedVersion };
    void this.writePending();
  }

  async flush(): Promise<void> {
    const version = this.acceptedVersion;
    if (this.completedVersion >= version) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.flushWaiters.push({ version, resolve });
    });
  }

  private async writePending(): Promise<void> {
    if (this.writing || !this.pending) {
      return;
    }

    const pending = this.pending;
    this.pending = null;
    this.writing = true;

    try {
      await saveLastRun(pending.state);
    } catch {
      // A failed Chrome storage write must not prevent a later snapshot from being saved.
    } finally {
      this.writing = false;
      this.completedVersion = pending.version;
      this.resolveFlushWaiters();
      void this.writePending();
    }
  }

  private resolveFlushWaiters(): void {
    const remaining: typeof this.flushWaiters = [];

    for (const waiter of this.flushWaiters) {
      if (waiter.version <= this.completedVersion) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }

    this.flushWaiters = remaining;
  }
}

export async function loadLastRun(): Promise<LastRunState> {
  const stored = await chrome.storage.local.get(LAST_RUN_KEY);
  const parsed = LastRunStateSchema.safeParse(stored[LAST_RUN_KEY]);

  return parsed.success ? parsed.data : { ...EMPTY_LAST_RUN };
}

export async function saveLastRun(state: LastRunState): Promise<void> {
  await chrome.storage.local.set({ [LAST_RUN_KEY]: LastRunStateSchema.parse(state) });
}

export async function clearLastRun(): Promise<void> {
  await chrome.storage.local.remove(LAST_RUN_KEY);
}
