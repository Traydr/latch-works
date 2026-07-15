// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECT_MESSAGE_TYPE } from "../shared/messages";
import { installCollector } from "./collector-entry";

afterEach(() => {
  delete (globalThis as typeof globalThis & { __gatherBoxCollectorCleanup?: () => void })
    .__gatherBoxCollectorCleanup;
  vi.unstubAllGlobals();
});

describe("collector entry registration", () => {
  it("replaces an earlier listener and returns request/source identity", async () => {
    const listeners: Array<(...args: any[]) => boolean | undefined> = [];
    const addListener = vi.fn((listener) => listeners.push(listener));
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener, removeListener } } });
    const collect = vi.fn().mockResolvedValue({ ok: false, code: "GRID_NOT_FOUND", message: "fixture" });

    installCollector("pixiv", collect);
    installCollector("pixiv", collect);

    expect(removeListener).toHaveBeenCalledWith(listeners[0]);
    const sendResponse = vi.fn();
    const accepted = listeners[1](
      {
        type: COLLECT_MESSAGE_TYPE,
        requestId: "run-2",
        sourceKey: "pixiv",
        pageUrl: window.location.href
      },
      {},
      sendResponse
    );
    expect(accepted).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        requestId: "run-2",
        sourceKey: "pixiv",
        result: { ok: false, code: "GRID_NOT_FOUND", message: "fixture" }
      })
    );
  });

  it("does not collect after the captured page URL changes", () => {
    let listener: ((...args: any[]) => boolean | undefined) | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((value) => {
            listener = value;
          }),
          removeListener: vi.fn()
        }
      }
    });
    const collect = vi.fn();
    installCollector("x", collect);
    const sendResponse = vi.fn();

    expect(
      listener?.(
        {
          type: COLLECT_MESSAGE_TYPE,
          requestId: "run-1",
          sourceKey: "x",
          pageUrl: "https://x.com/someone/status/2"
        },
        {},
        sendResponse
      )
    ).toBe(false);
    expect(collect).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ code: "UNSUPPORTED_SITE" }) })
    );
  });
});
