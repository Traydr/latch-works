import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGatherRunState, GATHER_RUN_STATE_KEY } from "./gather-run";

const storage = new Map<string, unknown>();

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
    getContexts: vi.fn(async () => []),
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" }
  }
});

describe("gather-run-store interrupt recovery", () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    chrome.runtime.getContexts = vi.fn(async () => []);
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
    chrome.runtime.getContexts = vi.fn(async () => [{ contextType: "OFFSCREEN_DOCUMENT" }]);

    const { markInterruptedGatherRun } = await import("./gather-run-store");
    const result = await markInterruptedGatherRun();

    expect(result?.phase).toBe("writing");
    expect(storage.get(GATHER_RUN_STATE_KEY)).toMatchObject({ phase: "writing" });
  });
});
