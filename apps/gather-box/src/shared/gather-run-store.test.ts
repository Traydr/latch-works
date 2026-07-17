import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatherRunState, GATHER_RUN_STATE_KEY } from "./gather-run";

const storage = new Map<string, unknown>();
const getContexts = vi.fn(async (_filter?: chrome.runtime.ContextFilter) => [] as chrome.runtime.ExtensionContext[]);

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: storage.get(key) ?? null })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) {
          storage.set(key, value);
        }
      })
    }
  },
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    getContexts,
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" }
  }
});

describe("gather-run-store interrupt recovery", () => {
  beforeEach(() => {
    storage.clear();
    getContexts.mockReset();
    getContexts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("marks non-terminal runs interrupted when no offscreen document is active", async () => {
    const run = createGatherRunState({
      id: "run-1",
      tabId: 1,
      windowId: 1,
      tabUrl: "https://example.com/gallery",
      siteKey: "pixiv"
    });
    storage.set(GATHER_RUN_STATE_KEY, { ...run, phase: "writing" });

    const { markInterruptedGatherRun } = await import("./gather-run-store");
    const interrupted = await markInterruptedGatherRun();

    expect(interrupted?.phase).toBe("interrupted");
    expect(storage.get(GATHER_RUN_STATE_KEY)).toMatchObject({ phase: "interrupted" });
  });

  it("leaves active runs alone while an offscreen gather document is still open", async () => {
    const run = createGatherRunState({
      id: "run-2",
      tabId: 2,
      windowId: 1,
      tabUrl: "https://example.com/gallery",
      siteKey: "pixiv"
    });
    storage.set(GATHER_RUN_STATE_KEY, { ...run, phase: "writing" });
    getContexts.mockResolvedValue([
      {
        contextId: "offscreen-1",
        contextType: "OFFSCREEN_DOCUMENT",
        documentUrl: "chrome-extension://test/offscreen/offscreen.html",
        frameId: 0,
        incognito: false,
        tabId: -1,
        windowId: -1
      } as chrome.runtime.ExtensionContext
    ]);

    const { markInterruptedGatherRun } = await import("./gather-run-store");
    const result = await markInterruptedGatherRun();

    expect(result?.phase).toBe("writing");
    expect(storage.get(GATHER_RUN_STATE_KEY)).toMatchObject({ phase: "writing" });
  });
});
