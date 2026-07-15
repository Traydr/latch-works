import { COLLECT_MESSAGE_TYPE } from "../shared/messages";
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY } from "../shared/settings";
import type { GalleryCollectResponse } from "../shared/types";
import { collectArchiveOfOurOwnData } from "./collectors/archiveofourown";
import { collectFanboxData } from "./collectors/fanbox";
import { collectFanfictionNetData } from "./collectors/fanfiction-net";
import { collectHentaiFoundryStoriesData } from "./collectors/hentai-foundry-stories";
import { collectKemonoData } from "./collectors/kemono";
import { collectMyHentaiGalleryData } from "./collectors/my-hentai-gallery";
import { collectPixivData } from "./collectors/pixiv";
import { collectXData } from "./collectors/x";
import { installPageShortcuts, type PageShortcutSettings } from "./page-shortcuts";

let pageShortcutSettings: PageShortcutSettings = {
  enabled: DEFAULT_SETTINGS.pageShortcutsEnabled
};
installPageShortcuts(document, chrome.runtime, () => pageShortcutSettings);
void refreshPageShortcutSettings().catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes[SETTINGS_KEY]) {
    void refreshPageShortcutSettings().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCollectMessage(message)) {
    return undefined;
  }

  void collectComicData(document, window.location)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        code: "COLLECTION_FAILED",
        message: getErrorMessage(error)
      } satisfies GalleryCollectResponse);
    });

  return true;
});

async function collectComicData(
  document: Document,
  location: Location
): Promise<GalleryCollectResponse> {
  if (location.hostname === "myhentaigallery.com") {
    return collectMyHentaiGalleryData(document, location);
  }

  if (location.hostname === "kemono.cr") {
    return collectKemonoData(document, location);
  }

  if (location.hostname.endsWith(".fanbox.cc") && location.pathname.startsWith("/posts/")) {
    return collectFanboxData(document, location);
  }

  if (location.hostname === "x.com") {
    return collectXData(document, location);
  }

  if (
    (location.hostname === "www.pixiv.net" || location.hostname === "pixiv.net") &&
    location.pathname.includes("/artworks/")
  ) {
    return collectPixivData(document, location);
  }

  if (location.hostname === "archiveofourown.org") {
    return collectArchiveOfOurOwnData(document, location);
  }

  if (location.hostname === "www.hentai-foundry.com" && location.pathname.startsWith("/stories/user/")) {
    return collectHentaiFoundryStoriesData(document, location);
  }

  if (location.hostname === "www.fanfiction.net" && location.pathname.startsWith("/s/")) {
    return collectFanfictionNetData(document, location);
  }

  return {
    ok: false,
    code: "UNSUPPORTED_SITE",
    message: "This page is not supported by the collector."
  };
}

function isCollectMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === COLLECT_MESSAGE_TYPE
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not collect comic data.";
}

async function refreshPageShortcutSettings(): Promise<void> {
  const settings = await loadSettings();
  pageShortcutSettings = {
    enabled: settings.pageShortcutsEnabled
  };
}
