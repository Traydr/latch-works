export const TRIGGER_DOWNLOAD_MESSAGE = "GATHER_BOX_TRIGGER_DOWNLOAD" as const;
export const OPEN_EXTENSION_MESSAGE = "GATHER_BOX_OPEN_EXTENSION" as const;

export interface TriggerDownloadMessage {
  type: typeof TRIGGER_DOWNLOAD_MESSAGE;
  target: "background";
}

export interface OpenExtensionMessage {
  type: typeof OPEN_EXTENSION_MESSAGE;
  target: "background";
}

export type GatherRuntimeMessage = TriggerDownloadMessage | OpenExtensionMessage;

export function isPageGatherMessage(value: unknown): value is GatherRuntimeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    value.target === "background" &&
    "type" in value &&
    (value.type === OPEN_EXTENSION_MESSAGE || value.type === TRIGGER_DOWNLOAD_MESSAGE)
  );
}
