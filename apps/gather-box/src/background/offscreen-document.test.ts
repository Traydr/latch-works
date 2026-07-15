import { describe, expect, it, vi } from "vitest";
import { OffscreenDocument } from "./offscreen-document";

describe("OffscreenDocument", () => {
  it("reuses an existing offscreen execution context", async () => {
    const platform = {
      getContexts: vi.fn().mockResolvedValue([{}]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn().mockResolvedValue(undefined)
    };

    await new OffscreenDocument(platform).ensure();

    expect(platform.createDocument).not.toHaveBeenCalled();
  });

  it("serializes concurrent creation attempts", async () => {
    let release: (() => void) | undefined;
    const platform = {
      getContexts: vi.fn().mockResolvedValue([]),
      getUrl: vi.fn().mockReturnValue("chrome-extension://test/offscreen/offscreen.html"),
      createDocument: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
    };
    const document = new OffscreenDocument(platform);

    const first = document.ensure();
    const second = document.ensure();
    await vi.waitFor(() => expect(platform.createDocument).toHaveBeenCalledTimes(1));
    release?.();
    await Promise.all([first, second]);

    expect(platform.createDocument).toHaveBeenCalledTimes(1);
  });
});
