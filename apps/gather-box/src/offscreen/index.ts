import {
  GATHER_RUN_EVENT,
  isCancelGatherRunMessage,
  isExecuteGatherRunMessage,
  type GatherRunEvent
} from "../shared/gather-run-messages";
import { executeGatherOutput } from "./executor";
import { proveOffscreenFilesystemAccess } from "./filesystem-proof";

const activeControllers = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionOriginSender(sender)) {
    return false;
  }

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

  if (isCancelGatherRunMessage(message)) {
    const controller = activeControllers.get(message.runId);
    controller?.abort();
    sendResponse({ aborted: Boolean(controller) });
    return false;
  }

  if (!isExecuteGatherRunMessage(message)) {
    return false;
  }
  if (activeControllers.has(message.runId)) {
    sendResponse({ accepted: true, duplicate: true });
    return false;
  }

  const controller = new AbortController();
  activeControllers.set(message.runId, controller);
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
    emit,
    signal: controller.signal
  })
    .catch((error) =>
      emit({
        kind: "failed",
        message: error instanceof Error ? error.message : "Gather execution failed."
      })
    )
    .finally(() => {
      activeControllers.delete(message.runId);
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

function isExtensionOriginSender(sender: chrome.runtime.MessageSender): boolean {
  return !sender.tab && sender.id === chrome.runtime.id;
}
