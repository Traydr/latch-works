import type { ModeMenu } from "../../../main/mode";
import type { AppCommand } from "../shared/types";

/** View's menu items, which go to the window. */
export function viewMenu(send: (command: AppCommand) => void): ModeMenu {
  const mac = process.platform === "darwin";

  return {
    file: [
      {
        label: "Open Folder…",
        accelerator: "CmdOrCtrl+O",
        click: () => send({ type: "open-folder-dialog" }),
      },
      {
        label: "Refresh",
        accelerator: mac ? "CmdOrCtrl+R" : "F5",
        click: () => send({ type: "refresh-current-folder" }),
      },
    ],
    view: [],
    settings: {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: () => send({ type: "toggle-settings" }),
    },
    help: [],
  };
}
