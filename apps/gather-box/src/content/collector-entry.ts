import { CollectComicGalleryMessageSchema } from "../shared/messages";
import type { SiteKey } from "../shared/sites";
import type { GalleryCollectResponse } from "../shared/types";

type Collector = (document: Document, location: Location) => GalleryCollectResponse | Promise<GalleryCollectResponse>;

/** Chrome hands listeners the message exactly as the sender posted it; the schema parses it. */
type RuntimeMessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

interface CollectorRegistrationGlobal {
  __gatherBoxCollectorCleanup?: () => void;
}

export function installCollector(sourceKey: SiteKey, collect: Collector): void {
  const registration = globalThis as typeof globalThis & CollectorRegistrationGlobal;
  registration.__gatherBoxCollectorCleanup?.();

  const listener: RuntimeMessageListener = (rawMessage, _sender, sendResponse) => {
    const parsed = CollectComicGalleryMessageSchema.safeParse(rawMessage);
    if (!parsed.success || parsed.data.sourceKey !== sourceKey) {
      return undefined;
    }

    const message = parsed.data;
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
