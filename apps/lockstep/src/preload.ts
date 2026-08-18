import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";
import type { ZodType } from "zod";

import { type JsonValue, LockstepRunEventSchema } from "./shared/contracts";
import { deserializeIpcResult } from "./shared/ipc";
import { InvokeIpcContracts } from "./shared/ipcContracts";
import type {
  LockstepApi,
  LockstepProfileInput,
  LockstepProfilePatch,
  LockstepRunEvent,
  RunRequest,
} from "./shared/types";

function invokeResult<T>(
  channel: string,
  schema: ZodType<T>,
  ...args: unknown[]
): Promise<ReturnType<typeof deserializeIpcResult<T>>> {
  return ipcRenderer
    .invoke(channel, ...args)
    .then((value: JsonValue) => deserializeIpcResult(value, schema, channel));
}

const api: LockstepApi = {
  cancelRun: () =>
    invokeResult(InvokeIpcContracts.cancelRun.channel, InvokeIpcContracts.cancelRun.responseSchema),
  createProfile: (input: LockstepProfileInput) =>
    invokeResult(
      InvokeIpcContracts.createProfile.channel,
      InvokeIpcContracts.createProfile.responseSchema,
      input,
    ),
  deleteProfile: (profileId: string) =>
    invokeResult(
      InvokeIpcContracts.deleteProfile.channel,
      InvokeIpcContracts.deleteProfile.responseSchema,
      profileId,
    ),
  doctor: (profileId: string) =>
    invokeResult(
      InvokeIpcContracts.doctor.channel,
      InvokeIpcContracts.doctor.responseSchema,
      profileId,
    ),
  getSettings: () =>
    invokeResult(
      InvokeIpcContracts.getSettings.channel,
      InvokeIpcContracts.getSettings.responseSchema,
    ),
  onRunEvent: (listener: (event: LockstepRunEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: JsonValue) => {
      const parsed = LockstepRunEventSchema.safeParse(payload);
      if (parsed.success) {
        listener(parsed.data);
      }
    };

    ipcRenderer.on("lockstep:run-event", handler);
    return () => {
      ipcRenderer.removeListener("lockstep:run-event", handler);
    };
  },
  pickSourceFolder: () =>
    invokeResult(
      InvokeIpcContracts.pickSourceFolder.channel,
      InvokeIpcContracts.pickSourceFolder.responseSchema,
    ),
  plan: (request: RunRequest) =>
    invokeResult(InvokeIpcContracts.plan.channel, InvokeIpcContracts.plan.responseSchema, request),
  prune: (request: RunRequest) =>
    invokeResult(
      InvokeIpcContracts.prune.channel,
      InvokeIpcContracts.prune.responseSchema,
      request,
    ),
  push: (request: RunRequest) =>
    invokeResult(InvokeIpcContracts.push.channel, InvokeIpcContracts.push.responseSchema, request),
  setActiveProfile: (profileId: string) =>
    invokeResult(
      InvokeIpcContracts.setActiveProfile.channel,
      InvokeIpcContracts.setActiveProfile.responseSchema,
      profileId,
    ),
  updateProfile: (profileId: string, patch: LockstepProfilePatch) =>
    invokeResult(
      InvokeIpcContracts.updateProfile.channel,
      InvokeIpcContracts.updateProfile.responseSchema,
      profileId,
      patch,
    ),
};

contextBridge.exposeInMainWorld("lockstep", api);
