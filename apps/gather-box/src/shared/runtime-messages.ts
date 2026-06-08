export const START_DOWNLOAD_MESSAGE = "GATHER_BOX_START_DOWNLOAD" as const;
export const OPEN_SIDE_PANEL_MESSAGE = "GATHER_BOX_OPEN_SIDE_PANEL" as const;
export const APPLY_UI_MODE_MESSAGE = "GATHER_BOX_APPLY_UI_MODE" as const;

export interface StartDownloadMessage {
  type: typeof START_DOWNLOAD_MESSAGE;
}

export interface OpenSidePanelMessage {
  type: typeof OPEN_SIDE_PANEL_MESSAGE;
}

export interface ApplyUiModeMessage {
  type: typeof APPLY_UI_MODE_MESSAGE;
}

export type GatherRuntimeMessage =
  | StartDownloadMessage
  | OpenSidePanelMessage
  | ApplyUiModeMessage;

export const PENDING_DOWNLOAD_SESSION_KEY = "gather-box-pending-download";
