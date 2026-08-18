import {
  CancelGatherRunMessageSchema,
  ExecuteGatherRunMessageSchema,
  GATHER_RUN_EVENT,
  GetGatherExecutorStatusMessageSchema,
  type GatherRunEvent
} from "../shared/gather-run-messages";
import { executeGatherOutput } from "./executor";
import { GatherExecutionSlot } from "./execution-slot";
import {
  OffscreenFilesystemProofMessageSchema,
  proveOffscreenFilesystemAccess
} from "./filesystem-proof";
import { createGatherRunEventEmitter } from "./run-event-emitter";

const executionSlot = new GatherExecutionSlot();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionOriginSender(sender)) {
    return false;
  }

  const proofRequest = OffscreenFilesystemProofMessageSchema.safeParse(message);
  if (proofRequest.success) {
    void proveOffscreenFilesystemAccess({
      siteKey: proofRequest.data.siteKey,
      useGlobalFolder: proofRequest.data.useGlobalFolder
    }).then(sendResponse, (error) =>
      sendResponse({
        ok: false,
        permission: "denied",
        message: error instanceof Error ? error.message : "Offscreen filesystem proof failed."
      })
    );
    return true;
  }

  if (GetGatherExecutorStatusMessageSchema.safeParse(message).success) {
    sendResponse({ activeRunId: executionSlot.activeRunId });
    return false;
  }

  const cancelRequest = CancelGatherRunMessageSchema.safeParse(message);
  if (cancelRequest.success) {
    sendResponse({ aborted: executionSlot.abort(cancelRequest.data.runId) });
    return false;
  }

  const executeRequest = ExecuteGatherRunMessageSchema.safeParse(message);
  if (!executeRequest.success) {
    return false;
  }
  const execute = executeRequest.data;
  const emitter = createGatherRunEventEmitter((event) => emitRunEvent(execute.runId, event));
  const start = executionSlot.start(
    execute.runId,
    async (signal) => {
      try {
        await executeGatherOutput({
          payload: execute.payload,
          settings: execute.settings,
          emit: emitter.emit,
          signal
        });
      } catch (error) {
        await emitter.emit(
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
        await emitter.emit({ kind: "cancelled", message: "Gather Run cancelled." });
      }
    },
    emitter.flush
  );
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
