import type { MenuItemConstructorOptions } from "electron";

import { MODE_IDS, MODE_LABELS, type ModeId, type ShellCommand } from "../shared/shell";
import type { ModeMenu } from "./mode";

/** The menu item id of a mode's entry in the View menu. */
function modeMenuItemId(mode: ModeId): string {
  return `mode-${mode}`;
}

interface AppMenuOptions {
  appName: string;
  packaged: boolean;
  /** The mode on screen, whose entry is checked. */
  mode: ModeId;
  /** What that mode adds to the menu. */
  modeMenu: ModeMenu | undefined;
  send: (command: ShellCommand) => void;
  /** Brings the old apps' data in again (File › Import from the Old Apps…). */
  importOldApps: () => void;
}

/**
 * The app menu: the shell's own items, with the mode on screen's woven in. Its commands go to the
 * window, which owns the mode and the sidebar; ⌘1–3 switch the modes.
 */
export function appMenu({
  appName,
  packaged,
  mode,
  modeMenu,
  send,
  importOldApps,
}: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = process.platform === "darwin";
  const settings = modeMenu?.settings;

  const modes = MODE_IDS.map(
    (id, index): MenuItemConstructorOptions => ({
      id: modeMenuItemId(id),
      label: MODE_LABELS[id],
      type: "radio",
      checked: id === mode,
      accelerator: `CmdOrCtrl+${index + 1}`,
      click: () => send({ type: "mode", mode: id }),
    }),
  );

  const separated = (items: MenuItemConstructorOptions[] | undefined) =>
    items && items.length > 0 ? [{ type: "separator" } as const, ...items] : [];

  return [
    ...(mac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about" },
              ...separated(settings ? [settings] : undefined),
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
      submenu: [
        ...(modeMenu?.file ?? []),
        ...(modeMenu?.file.length ? [{ type: "separator" } as const] : []),
        { label: "Import from the Old Apps…", click: importOldApps },
        { type: "separator" },
        ...(mac
          ? [{ role: "close" } as const]
          : [
              ...(settings ? [settings, { type: "separator" } as const] : []),
              { role: "quit" } as const,
            ]),
      ],
    },
    modeMenu?.edit ? { label: "Edit", submenu: modeMenu.edit } : { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...modes,
        ...separated(modeMenu?.view),
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
    ...(modeMenu?.help.length ? [{ role: "help" as const, submenu: modeMenu.help }] : []),
  ];
}
