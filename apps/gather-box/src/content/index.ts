import { COLLECT_MESSAGE_TYPE } from "../shared/messages";
import type { GalleryCollectResponse } from "../shared/types";
import { collectArchiveOfOurOwnData } from "./collectors/archiveofourown";
import { collectFanboxData } from "./collectors/fanbox";
import { collectFanfictionNetData } from "./collectors/fanfiction-net";
import { collectHentaiFoundryStoriesData } from "./collectors/hentai-foundry-stories";
import { collectKemonoData } from "./collectors/kemono";
import { collectMyHentaiGalleryData } from "./collectors/my-hentai-gallery";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCollectMessage(message)) {
    return undefined;
  }

  try {
    sendResponse(collectComicData(document, window.location));
  } catch (error) {
    sendResponse({
      ok: false,
      code: "COLLECTION_FAILED",
      message: getErrorMessage(error)
    } satisfies GalleryCollectResponse);
  }

  return false;
});

function collectComicData(document: Document, location: Location): GalleryCollectResponse {
  if (location.hostname === "myhentaigallery.com") {
    return collectMyHentaiGalleryData(document, location);
  }

  if (location.hostname === "kemono.cr") {
    return collectKemonoData(document, location);
  }

  if (location.hostname.endsWith(".fanbox.cc") && location.pathname.startsWith("/posts/")) {
    return collectFanboxData(document, location);
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
