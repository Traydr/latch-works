import {
  GATHER_RUN_EVENT,
  isExecuteGatherRunMessage,
  type GatherRunEvent
} from "../shared/gather-run-messages";
import { executeGatherOutput } from "./executor";
import { proveOffscreenFilesystemAccess } from "./filesystem-proof";

const activeRunIds = new Set<string>();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === "GATHER_BOX_OFFSCREEN_FILESYSTEM_PROOF" &&
    message?.target === "offscreen"
  ) {
    void proveOffscreenFilesystemAccess({
      siteKey: message.siteKey ?? null,
      useGlobalFolder: message.useGlobalFolder === true
    }).then(sendResponse, (error) =>
      sendResponse({
        ok: false,
        permission: "denied",
        message: error instanceof Error ? error.message : "Offscreen filesystem proof failed."
      })
    );
    return true;
  }
  if (!isExecuteGatherRunMessage(message)) {
    return false;
  }
  if (activeRunIds.has(message.runId)) {
    sendResponse({ accepted: true, duplicate: true });
    return false;
  }

  activeRunIds.add(message.runId);
  sendResponse({ accepted: true });
  let eventQueue = Promise.resolve();
  const emit = (event: GatherRunEvent): Promise<void> => {
    const delivery = eventQueue.then(() => emitRunEvent(message.runId, event));
    eventQueue = delivery.catch(() => undefined);
    return delivery;
  };
  void executeGatherOutput({
    payload: message.payload,
    settings: message.settings,
    emit
  })
    .catch((error) =>
      emit({
        kind: "failed",
        message: error instanceof Error ? error.message : "Gather execution failed."
      })
    )
    .finally(() => {
      activeRunIds.delete(message.runId);
    });
  return false;
});

async function emitRunEvent(runId: string, event: GatherRunEvent): Promise<void> {
  await chrome.runtime.sendMessage({
    type: GATHER_RUN_EVENT,
    target: "background",
    runId,
    event
  });
}
