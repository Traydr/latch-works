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
