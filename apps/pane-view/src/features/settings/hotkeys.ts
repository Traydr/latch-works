export const GALLERY_HOTKEYS = [
  { keys: "W/A/S/D or Arrow keys", action: "Move grid focus" },
  { keys: "Enter / F", action: "Open selected item" },
  { keys: "Shift+W", action: "Go to parent folder" },
  { keys: "Shift+S", action: "Open focused folder" },
  { keys: "Shift+A / Shift+D", action: "Previous / next sibling folder" },
  { keys: "Q / E", action: "Previous / next media in viewer" },
  { keys: "Space / 2", action: "Play or pause video" },
  { keys: "Escape", action: "Close viewer or overlay" },
  { keys: "?", action: "Show keyboard shortcuts" },
] as const;
