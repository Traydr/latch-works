import { afterEach, describe, expect, it, vi } from "vitest";
import type { PopupElements } from "../gather/dom";
import type { DirectoryStore } from "../gather/directory-store";
import { GatherController } from "./gather-controller";
import type { RetryGatherRunRequest, GatherRunResponse } from "./gather-run-messages";
import type { LastRunState } from "./last-run";
import type { GalleryImage } from "./types";

interface DeferredWrite {
  value: Record<string, LastRunState>;
  resolve: () => void;
}

const writes: DeferredWrite[] = [];
const sendMessage = vi.fn<(message: RetryGatherRunRequest) => Promise<GatherRunResponse>>();

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
  runtime: { sendMessage }
});

afterEach(() => {
  writes.length = 0;
  vi.clearAllMocks();
});

function stubDirectoryStore(overrides: Partial<DirectoryStore> = {}): DirectoryStore {
  return {
    clearDirectoryHandle: vi.fn(),
    ensureDirectoryPermission: vi.fn().mockResolvedValue("denied"),
    getDirectoryScopeLabel: vi.fn(() => "this site"),
    loadDirectoryHandle: vi.fn().mockResolvedValue(null),
    saveDirectoryHandle: vi.fn(),
    ...overrides
  };
}

function tabAt(url: string): chrome.tabs.Tab {
  return {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: false,
    incognito: false,
    index: 0,
    pinned: false,
    selected: true,
    url,
    windowId: 1
  };
}

function directoryHandleNamed(name: string): FileSystemDirectoryHandle {
  // SAFETY: the controller only reads `name` off a restored handle (setDirectoryHandle and the
  // retry path); every other member belongs to the browser-supplied handle it never fabricates.
  return { kind: "directory", name } as FileSystemDirectoryHandle;
}

describe("GatherController last-run persistence", () => {
  it("flushes current retry state after an older log save", async () => {
    const controller = new GatherController({ directoryStore: stubDirectoryStore() });
    const retryImage: GalleryImage = {
      fileName: "failed.jpg",
      originalUrl: "https://downloads.fanbox.cc/failed.jpg",
      pageNumber: 1,
      thumbnailUrl: null
    };

    controller["state"].activeTab = tabAt("https://www.fanbox.cc/@artist");
    controller["state"].siteKey = "fanbox";
    controller["logEntries"] = [{ message: "Collecting content metadata..." }];
    // SAFETY: persistLastRun only toggles the six buttons and folderName below; the rest of
    // PopupElements is read by render paths this test never reaches.
    controller["elements"] = {
      downloadButton: { disabled: false },
      cancelButton: { disabled: false },
      chooseFolder: { disabled: false },
      clearFolder: { disabled: false },
      retryButton: { disabled: false },
      copyErrorsButton: { disabled: false },
      folderName: { textContent: "" }
    } as PopupElements;

    const olderLogSave = controller["persistLastRun"]({});
    controller["logEntries"].push({ message: "Failed failed.jpg", tone: "error" });
    const terminalSave = controller["persistLastRun"]({
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
    const activeTabHandle = directoryHandleNamed("Pixiv");
    const failedRunHandle = directoryHandleNamed("Fanbox");
    const directories = stubDirectoryStore({
      loadDirectoryHandle: vi.fn().mockResolvedValue(failedRunHandle),
      ensureDirectoryPermission: vi.fn().mockResolvedValue("granted")
    });
    const controller = new GatherController({ directoryStore: directories });

    // Browsing pixiv while the retryable run belongs to fanbox — the site-scoped handles differ.
    controller["state"].activeTab = tabAt("https://www.pixiv.net/artworks/1");
    controller["state"].siteKey = "pixiv";
    controller["state"].directoryHandle = activeTabHandle;
    controller["state"].lastRun = {
      ...controller["state"].lastRun,
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
    controller["retryTarget"] = { runId: "run-9", siteKey: "fanbox" };

    // Any outcome the controller does not render keeps this test off the DOM-backed log path.
    sendMessage.mockResolvedValue({ outcome: "target-unavailable" });

    await controller["handleRetryFailed"]();

    expect(directories.loadDirectoryHandle).toHaveBeenCalledWith("fanbox", false);
    expect(directories.ensureDirectoryPermission).toHaveBeenCalledWith(failedRunHandle, true);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-9" }));
  });
});
