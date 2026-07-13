import { afterEach, describe, expect, it, vi } from "vitest";
import type { PopupElements } from "../popup/dom";
import { GatherController } from "./gather-controller";
import type { LastRunLogEntry, LastRunState } from "./last-run";
import type { GalleryImage } from "./types";

interface DeferredWrite {
  value: Record<string, LastRunState>;
  resolve: () => void;
}

const writes: DeferredWrite[] = [];

vi.stubGlobal("chrome", {
  storage: {
    local: {
      set: vi.fn((value: Record<string, LastRunState>) =>
        new Promise<void>((resolve) => {
          writes.push({ value, resolve });
        })
      )
    }
  }
});

afterEach(() => {
  writes.length = 0;
  vi.clearAllMocks();
});

describe("GatherController last-run persistence", () => {
  it("flushes current retry state after an older log save", async () => {
    const controller = new GatherController() as unknown as {
      state: {
        activeTab: chrome.tabs.Tab | null;
        siteKey: "fanbox" | null;
        directoryHandle: FileSystemDirectoryHandle | null;
        lastRun: LastRunState;
      };
      elements: PopupElements;
      logEntries: LastRunLogEntry[];
      persistLastRun(patch: Partial<LastRunState>): Promise<void>;
    };
    const retryImage: GalleryImage = {
      fileName: "failed.jpg",
      originalUrl: "https://downloads.fanbox.cc/failed.jpg",
      pageNumber: 1,
      thumbnailUrl: null
    };

    controller.state.activeTab = { url: "https://www.fanbox.cc/@artist" } as chrome.tabs.Tab;
    controller.state.siteKey = "fanbox";
    controller.logEntries = [{ message: "Collecting content metadata..." }];
    controller.elements = {
      downloadButton: { disabled: false },
      chooseFolder: { disabled: false },
      clearFolder: { disabled: false },
      retryButton: { disabled: false },
      copyErrorsButton: { disabled: false },
      folderName: { textContent: "" }
    } as PopupElements;

    const olderLogSave = controller.persistLastRun({});
    controller.logEntries.push({ message: "Failed failed.jpg", tone: "error" });
    const terminalSave = controller.persistLastRun({
      failedItems: [{ fileName: "failed.jpg", reason: "network" }],
      retryImages: [retryImage],
      canRetry: true
    });

    expect(writes).toHaveLength(1);
    writes[0].resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1].resolve();
    await Promise.all([olderLogSave, terminalSave]);

    expect(writes[1].value["gather-box-last-run"]).toMatchObject({
      failedItems: [{ fileName: "failed.jpg", reason: "network" }],
      retryImages: [retryImage],
      canRetry: true
    });
  });
});
