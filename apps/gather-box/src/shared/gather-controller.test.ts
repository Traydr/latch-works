import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PopupElements } from "../gather/dom";
import { ensureDirectoryPermission, loadDirectoryHandle } from "../gather/directory-store";
import { GatherController } from "./gather-controller";
import type { LastRunLogEntry, LastRunState } from "./last-run";
import type { GalleryImage } from "./types";
import type { SiteKey } from "./sites";

vi.mock("../gather/directory-store", () => ({
  loadDirectoryHandle: vi.fn(),
  ensureDirectoryPermission: vi.fn(),
  saveDirectoryHandle: vi.fn(),
  clearDirectoryHandle: vi.fn(),
  getDirectoryScopeLabel: vi.fn(() => "this site")
}));

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
  },
  runtime: {
    sendMessage: vi.fn()
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
      cancelButton: { disabled: false },
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

describe("GatherController retry", () => {
  it("confirms the failed run's folder, not the active tab's", async () => {
    const controller = new GatherController() as unknown as {
      state: {
        activeTab: chrome.tabs.Tab | null;
        siteKey: SiteKey | null;
        directoryHandle: FileSystemDirectoryHandle | null;
        lastRun: LastRunState;
      };
      retryTarget: { runId: string; siteKey: SiteKey } | null;
      handleRetryFailed(): Promise<void>;
    };
    const activeTabHandle = { name: "Pixiv" } as FileSystemDirectoryHandle;
    const failedRunHandle = { name: "Fanbox" } as FileSystemDirectoryHandle;

    // Browsing pixiv while the retryable run belongs to fanbox — the site-scoped handles differ.
    controller.state.activeTab = { url: "https://www.pixiv.net/artworks/1" } as chrome.tabs.Tab;
    controller.state.siteKey = "pixiv";
    controller.state.directoryHandle = activeTabHandle;
    controller.state.lastRun = {
      ...controller.state.lastRun,
      canRetry: true,
      retryImages: [
        {
          fileName: "failed.jpg",
          originalUrl: "https://downloads.fanbox.cc/failed.jpg",
          pageNumber: 1,
          thumbnailUrl: null
        }
      ]
    };
    controller.retryTarget = { runId: "run-9", siteKey: "fanbox" };

    const sendMessage = chrome.runtime.sendMessage as unknown as Mock;
    vi.mocked(loadDirectoryHandle).mockResolvedValue(failedRunHandle);
    vi.mocked(ensureDirectoryPermission).mockResolvedValue("granted");
    // Any outcome the controller does not render keeps this test off the DOM-backed log path.
    sendMessage.mockResolvedValue({ outcome: "target-unavailable" });

    await controller.handleRetryFailed();

    expect(loadDirectoryHandle).toHaveBeenCalledWith("fanbox", false);
    expect(ensureDirectoryPermission).toHaveBeenCalledWith(failedRunHandle, true);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-9" }));
  });
});
