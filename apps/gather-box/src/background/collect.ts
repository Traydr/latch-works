import { collectorScriptPath } from "../shared/constants";
import { toError } from "../shared/errors";
import {
  COLLECT_MESSAGE_TYPE,
  type CollectMessage,
  CollectResponseSchema,
} from "../shared/protocol/collector";
import type { MatchedPage } from "../shared/source-catalog";
import type { GatherOutput } from "../shared/types";

/**
 * Injects the page's own collector into the tab's main frame and asks it for the page's output.
 * The answer is parsed and checked against the request before it is trusted.
 */
export async function injectCollectorAndCollect(
  tabId: number,
  page: MatchedPage,
  request: { requestId: string; pageUrl: string },
): Promise<GatherOutput> {
  const { source, address } = page;

  const message: CollectMessage = {
    type: COLLECT_MESSAGE_TYPE,
    requestId: request.requestId,
    sourceKey: source.key,
    pageUrl: request.pageUrl,
    address: Object.fromEntries(
      Object.entries(address).flatMap(([name, value]): [string, string][] =>
        value === undefined ? [] : [[name, value]],
      ),
    ),
  };

  const response = CollectResponseSchema.safeParse(
    await runCollector(tabId, message).catch((error) => {
      throw new Error(`Could not run the ${source.label} collector: ${toError(error).message}`);
    }),
  );

  if (
    !response.success ||
    response.data.requestId !== request.requestId ||
    response.data.sourceKey !== source.key
  ) {
    throw new Error(`The ${source.label} collector returned a stale or mismatched response.`);
  }

  const result = response.data.result;

  if (!result.ok) {
    throw new Error(result.message || "The source page did not return collection data.");
  }

  if (result.site !== source.key || result.outputKind !== source.output.kind) {
    throw new Error(`The ${source.label} collector returned another source's output.`);
  }

  return result;
}

async function runCollector(tabId: number, message: CollectMessage) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: [collectorScriptPath(message.sourceKey)],
  });

  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}
