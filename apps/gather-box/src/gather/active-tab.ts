import { COLLECT_MESSAGE_TYPE, type CollectComicGalleryMessage } from "../shared/messages";
import type { GalleryCollectResponse } from "../shared/types";
import { formatError } from "./errors";

const COLLECTOR_FILE = "content/gallery-collector.js";

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

export async function ensureCollectorAndCollect(
  tabId: number,
  onInjecting: () => void
): Promise<GalleryCollectResponse> {
  const message: CollectComicGalleryMessage = { type: COLLECT_MESSAGE_TYPE };

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw new Error(`Could not reach the page collector: ${formatError(error)}`);
    }

    onInjecting();
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [COLLECTOR_FILE]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

function isMissingReceiverError(error: unknown): boolean {
  return formatError(error).includes("Receiving end does not exist");
}
