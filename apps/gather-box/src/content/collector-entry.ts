import { toError } from "../shared/errors";
import { CollectMessageSchema, type CollectResponse } from "../shared/protocol/collector";
import type { PageAddress, SiteKey } from "../shared/source-catalog";
import type { CollectionResult, CollectorResult } from "../shared/types";

/** The parts of the page address a collector reads; a `URL` supplies all of them. */
export type PageLocation = Pick<Location, "href" | "hostname" | "pathname">;

/** The page a collector reads: its location, and its address as the source's pattern parsed it. */
export interface SourcePage {
  location: PageLocation;
  address: PageAddress;
}

export type Collector = (
  document: Document,
  page: SourcePage,
) => CollectorResult | Promise<CollectorResult>;

declare global {
  /** Set by the collector this content script installs, so a re-injection can uninstall it. */
  // eslint-disable-next-line no-var
  var __gatherBoxCollectorCleanup: (() => void) | undefined;
}

/**
 * Answers the service worker's collect request for this source. The build generates each
 * collector's entry as a call to this with the catalog key and the collector's `collect`.
 */
export function installCollector(sourceKey: SiteKey, collect: Collector): void {
  globalThis.__gatherBoxCollectorCleanup?.();

  const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
    rawMessage,
    _sender,
    sendResponse,
  ) => {
    const parsed = CollectMessageSchema.safeParse(rawMessage);

    if (!parsed.success || parsed.data.sourceKey !== sourceKey) {
      return false;
    }

    const message = parsed.data;

    const respond = (result: CollectionResult) =>
      sendResponse({ requestId: message.requestId, sourceKey, result } satisfies CollectResponse);

    if (message.pageUrl !== window.location.href) {
      respond({ ok: false, message: "The source page navigated before its collector ran." });

      return false;
    }

    void Promise.resolve()
      .then(() => collect(document, { location: window.location, address: message.address }))
      .then(
        (result) =>
          respond(result.ok ? { ...result, site: sourceKey, pageUrl: message.pageUrl } : result),
        (error) => respond({ ok: false, message: toError(error).message }),
      );

    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  globalThis.__gatherBoxCollectorCleanup = () => {
    chrome.runtime.onMessage.removeListener(listener);
    globalThis.__gatherBoxCollectorCleanup = undefined;
  };
}
