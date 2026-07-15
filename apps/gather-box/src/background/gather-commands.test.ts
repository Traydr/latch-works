import { describe, expect, it, vi } from "vitest";
import { GatherCommands } from "./gather-commands";

const tab = { id: 9, windowId: 3, url: "https://www.pixiv.net/artworks/1" } as chrome.tabs.Tab;

describe("GatherCommands", () => {
  it("opens and closes the same window deterministically", async () => {
    const panel = { open: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const commands = new GatherCommands({ startForTab: vi.fn() }, panel);

    await expect(commands.toggle(tab)).resolves.toEqual({ outcome: "opened" });
    await expect(commands.toggle(tab)).resolves.toEqual({ outcome: "closed" });
    expect(panel.open).toHaveBeenCalledWith({ windowId: 3 });
    expect(panel.close).toHaveBeenCalledWith({ windowId: 3 });
  });

  it("opens the panel and starts one run for the captured tab", async () => {
    const startForTab = vi.fn().mockResolvedValue({ outcome: "started", run: { id: "run-1" } });
    const panel = { open: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const commands = new GatherCommands({ startForTab }, panel);

    await expect(commands.gather(tab)).resolves.toMatchObject({ outcome: "started" });
    expect(startForTab).toHaveBeenCalledOnce();
    expect(startForTab).toHaveBeenCalledWith(tab);
    expect(panel.open).toHaveBeenCalledWith({ windowId: 3 });
  });

  it("reports a missing Chrome-owned window identity", async () => {
    const commands = new GatherCommands({ startForTab: vi.fn() }, { open: vi.fn(), close: vi.fn() });
    await expect(commands.gather({ id: 1 } as chrome.tabs.Tab)).resolves.toEqual({
      outcome: "target-unavailable"
    });
  });
});
