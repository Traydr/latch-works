import { afterEach, describe, expect, it, vi } from "vitest";
import { getGatherSource } from "../shared/source-catalog";
import { injectCollectorAndCollect } from "./active-tab";

afterEach(() => vi.unstubAllGlobals());

describe("selected Gather Source injection", () => {
  it("injects exactly one catalog entry into the captured main frame", async () => {
    const source = getGatherSource("pixiv")!;
    const executeScript = vi.fn().mockResolvedValue([]);
    const sendMessage = vi.fn().mockImplementation((_tabId, message) =>
      Promise.resolve({ requestId: message.requestId, sourceKey: "pixiv", result: { ok: false, code: "GRID_NOT_FOUND", message: "fixture" } })
    );
    vi.stubGlobal("chrome", { scripting: { executeScript }, tabs: { sendMessage } });

    const result = await injectCollectorAndCollect({
      tabId: 42,
      pageUrl: "https://www.pixiv.net/artworks/123",
      requestId: "run-1",
      source,
      onInjecting: vi.fn()
    });

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42, frameIds: [0] },
      files: ["content/collectors/pixiv.js"]
    });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ requestId: "run-1", sourceKey: "pixiv" }),
      { frameId: 0 }
    );
    expect(result).toMatchObject({ ok: false, code: "GRID_NOT_FOUND" });
  });

  it("rejects a response from an older request", async () => {
    const source = getGatherSource("x")!;
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({
          requestId: "old-run",
          sourceKey: "x",
          result: { ok: false, code: "COLLECTION_FAILED", message: "stale" }
        })
      }
    });

    await expect(
      injectCollectorAndCollect({
        tabId: 7,
        pageUrl: "https://x.com/user/status/1",
        requestId: "new-run",
        source,
        onInjecting: vi.fn()
      })
    ).rejects.toThrow("stale or mismatched response");
  });
});
