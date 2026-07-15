import {
  COLLECT_MESSAGE_TYPE,
  type CollectComicGalleryMessage,
  type CollectComicGalleryResponse
} from "../shared/messages";
import type { GatherSource } from "../shared/source-catalog";
import type { GalleryCollectResponse } from "../shared/types";
import { formatError } from "./errors";

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

export async function injectCollectorAndCollect(input: {
  tabId: number;
  pageUrl: string;
  requestId: string;
  source: GatherSource;
  onInjecting: () => void;
}): Promise<GalleryCollectResponse> {
  const { tabId, pageUrl, requestId, source, onInjecting } = input;
  const message: CollectComicGalleryMessage = {
    type: COLLECT_MESSAGE_TYPE,
    requestId,
    sourceKey: source.key,
    pageUrl
  };

  try {
    onInjecting();
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: [source.collectorEntry]
    });
    const response = await chrome.tabs.sendMessage<
      CollectComicGalleryMessage,
      CollectComicGalleryResponse
    >(tabId, message, { frameId: 0 });
    if (
      !response ||
      response.requestId !== requestId ||
      response.sourceKey !== source.key ||
      !response.result
    ) {
      throw new Error("The selected collector returned a stale or mismatched response.");
    }
    return response.result;
  } catch (error) {
    throw new Error(`Could not run the ${source.label} collector: ${formatError(error)}`);
  }
}
