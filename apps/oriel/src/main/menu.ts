import type { MenuItemConstructorOptions } from "electron";

import { MODE_IDS, MODE_LABELS, type ModeId, type ShellCommand } from "../shared/shell";

/** The menu item id of a mode's entry in the View menu, so its check mark can follow the mode. */
export function modeMenuItemId(mode: ModeId): string {
  return `mode-${mode}`;
}

interface AppMenuOptions {
  appName: string;
  packaged: boolean;
  send: (command: ShellCommand) => void;
}

/**
 * The app menu. Its commands go to the window, which owns the mode and the sidebar; ⌘1–3 switch
 * the modes.
 */
export function appMenu({ appName, packaged, send }: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = process.platform === "darwin";

  const modes = MODE_IDS.map(
    (mode, index): MenuItemConstructorOptions => ({
      id: modeMenuItemId(mode),
      label: MODE_LABELS[mode],
      type: "radio",
      accelerator: `CmdOrCtrl+${index + 1}`,
      click: () => send({ type: "mode", mode }),
    }),
  );

  return [
    ...(mac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ] satisfies MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [mac ? { role: "close" } : { role: "quit" }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...modes,
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => send({ type: "toggle-sidebar" }),
        },
        { role: "togglefullscreen" },
        ...(packaged
          ? []
          : [
              { type: "separator" } as const,
              { role: "reload" } as const,
              { role: "toggleDevTools" } as const,
            ]),
      ],
    },
    { role: "windowMenu" },
  ];
}
