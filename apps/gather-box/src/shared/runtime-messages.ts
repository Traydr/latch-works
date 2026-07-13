export const START_DOWNLOAD_MESSAGE = "GATHER_BOX_START_DOWNLOAD" as const;
export const TRIGGER_DOWNLOAD_MESSAGE = "GATHER_BOX_TRIGGER_DOWNLOAD" as const;
export const OPEN_EXTENSION_MESSAGE = "GATHER_BOX_OPEN_EXTENSION" as const;
export const TOGGLE_OPEN_UI_MESSAGE = "GATHER_BOX_TOGGLE_OPEN_UI" as const;
export const OPEN_SIDE_PANEL_MESSAGE = "GATHER_BOX_OPEN_SIDE_PANEL" as const;
export const APPLY_UI_MODE_MESSAGE = "GATHER_BOX_APPLY_UI_MODE" as const;

export interface StartDownloadMessage {
  type: typeof START_DOWNLOAD_MESSAGE;
}

export interface TriggerDownloadMessage {
  type: typeof TRIGGER_DOWNLOAD_MESSAGE;
  primaryUi: "popup" | "sidePanel";
}

export interface OpenExtensionMessage {
  type: typeof OPEN_EXTENSION_MESSAGE;
  primaryUi: "popup" | "sidePanel";
}

export interface ToggleOpenUiMessage {
  type: typeof TOGGLE_OPEN_UI_MESSAGE;
}

export interface OpenSidePanelMessage {
  type: typeof OPEN_SIDE_PANEL_MESSAGE;
}

export interface ApplyUiModeMessage {
  type: typeof APPLY_UI_MODE_MESSAGE;
}

export type GatherRuntimeMessage =
  | StartDownloadMessage
  | TriggerDownloadMessage
  | OpenExtensionMessage
  | ToggleOpenUiMessage
  | OpenSidePanelMessage
  | ApplyUiModeMessage;

export const PENDING_DOWNLOAD_SESSION_KEY = "gather-box-pending-download";
