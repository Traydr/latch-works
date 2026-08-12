import {
  GATHER_RUN_EVENT,
  isGetGatherExecutorStatusMessage,
  isCancelGatherRunMessage,
  isExecuteGatherRunMessage,
  type GatherRunEvent
} from "../shared/gather-run-messages";
import { executeGatherOutput } from "./executor";
import { GatherExecutionSlot } from "./execution-slot";
import { proveOffscreenFilesystemAccess } from "./filesystem-proof";

const executionSlot = new GatherExecutionSlot();

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

  if (isGetGatherExecutorStatusMessage(message)) {
    sendResponse({ activeRunId: executionSlot.activeRunId });
    return false;
  }

  if (isCancelGatherRunMessage(message)) {
    sendResponse({ aborted: executionSlot.abort(message.runId) });
    return false;
  }

  if (!isExecuteGatherRunMessage(message)) {
    return false;
  }
  let eventQueue = Promise.resolve();
  const emit = (event: GatherRunEvent): Promise<void> => {
    const delivery = eventQueue.then(() => emitRunEvent(message.runId, event));
    eventQueue = delivery.catch(() => undefined);
    return delivery;
  };
  const start = executionSlot.start(message.runId, async (signal) => {
    try {
      await executeGatherOutput({
        payload: message.payload,
        settings: message.settings,
        emit,
        signal
      });
    } catch (error) {
      await emit(
        signal.aborted
          ? { kind: "cancelled", message: "Gather Run cancelled." }
          : {
              kind: "failed",
              message: error instanceof Error ? error.message : "Gather execution failed."
            }
      );
      return;
    }
    if (signal.aborted) {
      await emit({ kind: "cancelled", message: "Gather Run cancelled." });
    }
  });
  sendResponse({
    accepted: start !== "busy",
    duplicate: start === "duplicate",
    busy: start === "busy"
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
