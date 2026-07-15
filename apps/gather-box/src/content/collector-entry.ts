import {
  isCollectComicGalleryMessage,
  type CollectComicGalleryResponse
} from "../shared/messages";
import type { SiteKey } from "../shared/sites";
import type { GalleryCollectResponse } from "../shared/types";

type Collector = (document: Document, location: Location) => GalleryCollectResponse | Promise<GalleryCollectResponse>;

interface CollectorRegistrationGlobal {
  __gatherBoxCollectorCleanup?: () => void;
}

export function installCollector(sourceKey: SiteKey, collect: Collector): void {
  const registration = globalThis as typeof globalThis & CollectorRegistrationGlobal;
  registration.__gatherBoxCollectorCleanup?.();

  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: CollectComicGalleryResponse) => void
  ): boolean | undefined => {
    if (!isCollectComicGalleryMessage(message) || message.sourceKey !== sourceKey) {
      return undefined;
    }
    if (message.pageUrl !== window.location.href) {
      sendResponse({
        requestId: message.requestId,
        sourceKey,
        result: {
          ok: false,
          code: "UNSUPPORTED_SITE",
          message: "The source page navigated before its collector ran."
        }
      });
      return false;
    }

    void Promise.resolve(collect(document, window.location)).then(
      (result) => sendResponse({ requestId: message.requestId, sourceKey, result }),
      (error) =>
        sendResponse({
          requestId: message.requestId,
          sourceKey,
          result: {
            ok: false,
            code: "COLLECTION_FAILED",
            message: error instanceof Error ? error.message : "Gather Source collection failed."
          }
        })
    );
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  registration.__gatherBoxCollectorCleanup = () => {
    chrome.runtime.onMessage.removeListener(listener);
    delete registration.__gatherBoxCollectorCleanup;
  };
}
