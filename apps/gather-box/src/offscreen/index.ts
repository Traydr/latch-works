import { isAbortError, toError } from "../shared/errors";
import { RUN_CANCELLED_MESSAGE } from "../shared/gather-run";
import {
  answerChannel,
  type ChannelFailure,
  failChannel,
  isExtensionPageSender,
  listenOnChannels,
} from "../shared/messaging";
import {
  CANCEL_GATHER_RUN,
  EXECUTE_GATHER_RUN,
  type ExecuteGatherRunMessage,
  type ExecutorRequest,
  ExecutorRequestSchema,
  type ExecutorResponses,
  GET_GATHER_EXECUTOR_STATUS,
} from "../shared/protocol/executor";
import { sendGatherRunEvent } from "../shared/protocol/run-events";
import { GatherExecutionSlot } from "./execution-slot";
import { executeGatherOutput } from "./executor";
import { createGatherRunEventEmitter, type GatherRunEventEmitter } from "./run-event-emitter";

const executionSlot = new GatherExecutionSlot();

/** Each run's reporter, kept until its held report is accepted so a re-run can take it over. */
const runEmitters = new Map<string, GatherRunEventEmitter>();

listenOnChannels(
  answerChannel<ExecutorRequest, ExecutorResponses, ChannelFailure>({
    schema: ExecutorRequestSchema,
    refuse: (sender) =>
      isExtensionPageSender(sender) ? null : "Only Gather Box may drive the executor.",
    fail: failChannel,
    handlers: {
      [GET_GATHER_EXECUTOR_STATUS]: async () => ({ activeRunId: executionSlot.activeRunId }),
      [CANCEL_GATHER_RUN]: async (request) => ({ aborted: executionSlot.abort(request.runId) }),
      [EXECUTE_GATHER_RUN]: async (request) => startExecution(request),
    },
  }),
);

function startExecution(
  execute: ExecuteGatherRunMessage,
): ExecutorResponses[typeof EXECUTE_GATHER_RUN] {
  const emitter = createGatherRunEventEmitter(async (event) => {
    const response = await sendGatherRunEvent(execute.runId, event);

    return response.outcome === "accepted";
  });

  const start = executionSlot.start(
    execute.runId,
    async (signal) => {
      try {
        await executeGatherOutput({
          payload: execute.payload,
          settings: execute.settings,
          destinationId: execute.destinationId,
          profileId: execute.profileId,
          emit: emitter.emit,
          signal,
        });
      } catch (error) {
        await emitter.emit(
          signal.aborted || isAbortError(toError(error))
            ? { kind: "cancelled", message: RUN_CANCELLED_MESSAGE }
            : { kind: "failed", message: toError(error).message },
        );

        return;
      }

      if (signal.aborted) {
        await emitter.emit({ kind: "cancelled", message: RUN_CANCELLED_MESSAGE });
      }
    },
    () =>
      emitter.flush().finally(() => {
        if (runEmitters.get(execute.runId) === emitter) {
          runEmitters.delete(execute.runId);
        }
      }),
  );

  if (start === "started") {
    // The background re-dispatched this run, so an earlier execution's report is out of date.
    runEmitters.get(execute.runId)?.stop();
    runEmitters.set(execute.runId, emitter);
  }

  return start === "busy" ? { outcome: "busy" } : { outcome: "accepted" };
}
