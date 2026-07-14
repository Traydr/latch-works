import { formatError } from "../shared/format-error";
import { COLLECT_MESSAGE_TYPE } from "../shared/messages";
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY } from "../shared/settings";
import { getSiteKeyFromUrl, type SiteKey } from "../shared/sites";
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

const COLLECTORS: Record<
  SiteKey,
  (document: Document, location: Location) => GalleryCollectResponse | Promise<GalleryCollectResponse>
> = {
  myhentaigallery: collectMyHentaiGalleryData,
  kemono: collectKemonoData,
  fanbox: collectFanboxData,
  x: collectXData,
  pixiv: collectPixivData,
  archiveofourown: collectArchiveOfOurOwnData,
  "hentaifoundry-stories": collectHentaiFoundryStoriesData,
  "fanfiction-net": collectFanfictionNetData
};

let pageShortcutSettings: PageShortcutSettings = {
  enabled: DEFAULT_SETTINGS.shortcutsEnabled,
  primaryUi: DEFAULT_SETTINGS.primaryUi
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
        message: formatError(error, "Could not collect comic data.")
      } satisfies GalleryCollectResponse);
    });

  return true;
});

async function collectComicData(
  document: Document,
  location: Location
): Promise<GalleryCollectResponse> {
  const siteKey = getSiteKeyFromUrl(location.href);
  if (!siteKey) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This page is not supported by the collector."
    };
  }

  return COLLECTORS[siteKey](document, location);
}

function isCollectMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === COLLECT_MESSAGE_TYPE
  );
}

async function refreshPageShortcutSettings(): Promise<void> {
  const settings = await loadSettings();
  pageShortcutSettings = {
    enabled: settings.shortcutsEnabled,
    primaryUi: settings.primaryUi
  };
}
