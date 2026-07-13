import { afterEach, describe, expect, it, vi } from "vitest";
import { LastRunWriter, type LastRunState } from "./last-run";

interface DeferredWrite {
  state: LastRunState;
  resolve: () => void;
  reject: (error: Error) => void;
}

const deferredWrites: DeferredWrite[] = [];
let activeWrites = 0;
let maxActiveWrites = 0;

vi.stubGlobal("chrome", {
  storage: {
    local: {
      set: vi.fn((value: Record<string, LastRunState>) => {
        const state = value["gather-box-last-run"];
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);

        return new Promise<void>((resolve, reject) => {
          deferredWrites.push({
            state,
            resolve: () => {
              activeWrites -= 1;
              resolve();
            },
            reject: (error) => {
              activeWrites -= 1;
              reject(error);
            }
          });
        });
      })
    }
  }
});

afterEach(() => {
  deferredWrites.length = 0;
  activeWrites = 0;
  maxActiveWrites = 0;
  vi.clearAllMocks();
});

function state(timestamp: number, canRetry = false): LastRunState {
  return {
    timestamp,
    siteKey: "fanbox",
    tabUrl: "https://www.fanbox.cc/@artist",
    destinationPreview: "artist",
    log: [{ message: `log ${timestamp}` }],
    failedItems: canRetry ? [{ fileName: "failed.jpg", reason: "network" }] : [],
    retryImages: canRetry
      ? [
          {
            fileName: "failed.jpg",
            originalUrl: "https://downloads.fanbox.cc/failed.jpg",
            pageNumber: 1,
            thumbnailUrl: null
          }
        ]
      : [],
    canRetry
  };
}

describe("LastRunWriter", () => {
  it("does nothing when flushed without queued work", async () => {
    const writer = new LastRunWriter();

    await expect(writer.flush()).resolves.toBeUndefined();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("serializes rapid writes and persists the newest queued snapshot", async () => {
    const writer = new LastRunWriter();
    writer.enqueue(state(1));
    writer.enqueue(state(2));
    writer.enqueue(state(3, true));
    const flushed = writer.flush();

    expect(deferredWrites).toHaveLength(1);
    expect(maxActiveWrites).toBe(1);
    expect(deferredWrites[0].state.timestamp).toBe(1);

    deferredWrites[0].resolve();
    await vi.waitFor(() => expect(deferredWrites).toHaveLength(2));
    expect(maxActiveWrites).toBe(1);
    expect(deferredWrites[1].state).toMatchObject({
      timestamp: 3,
      failedItems: [{ fileName: "failed.jpg", reason: "network" }],
      retryImages: [{ fileName: "failed.jpg" }],
      canRetry: true
    });

    deferredWrites[1].resolve();
    await expect(flushed).resolves.toBeUndefined();
  });

  it("continues after a rejected write and flushes a later snapshot", async () => {
    const writer = new LastRunWriter();
    writer.enqueue(state(1));
    writer.enqueue(state(2, true));
    const flushed = writer.flush();

    deferredWrites[0].reject(new Error("storage unavailable"));
    await vi.waitFor(() => expect(deferredWrites).toHaveLength(2));
    expect(maxActiveWrites).toBe(1);
    expect(deferredWrites[1].state.timestamp).toBe(2);

    deferredWrites[1].resolve();
    await expect(flushed).resolves.toBeUndefined();
  });
});
