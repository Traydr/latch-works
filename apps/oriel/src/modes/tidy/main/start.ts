import type { Job } from "@latch-works/glazier-core/contract";
import type { MenuItemConstructorOptions } from "electron";

import type { ModeContext, ModeHost, ModeMenu } from "../../../main/mode";
import { type AppCommand, RendererChannels } from "../shared/messages";
import { EngineHost } from "./engine-host";
import { registerIpc } from "./ipc";
import { handleMediaProtocol } from "./media-protocol";

interface TidyOptions extends ModeContext {
  packaged: boolean;
}

/** Whether a job is a change to the archive (applying a plan or undoing one) still under way. */
function isRunningChange(job: Job): boolean {
  return (
    (job.type === "apply" || job.type === "undo") &&
    (job.state === "queued" || job.state === "running" || job.state === "paused")
  );
}

/**
 * Tidy's menu items. They go to the window, which decides what they mean where focus is: Undo
 * and Select All act on a text field when one is focused, and on files otherwise.
 */
function tidyMenu(send: (command: AppCommand) => void): ModeMenu {
  const views = [
    ["Overview", "view:overview"],
    ["Duplicates", "view:duplicates"],
    ["Convert", "view:convert"],
    ["Clean Up", "view:cleanup"],
    ["Library", "view:library"],
    ["History", "view:history"],
    ["Holding", "view:holding"],
  ] as const satisfies ReadonlyArray<readonly [string, AppCommand]>;

  return {
    file: [
      { label: "Add Folder…", accelerator: "CmdOrCtrl+O", click: () => send("add-root") },
      { label: "Rescan", accelerator: "CmdOrCtrl+R", click: () => send("rescan") },
    ],
    edit: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => send("select-all") },
      { type: "separator" },
      { label: "Find", accelerator: "CmdOrCtrl+F", click: () => send("find") },
    ],
    // ⌘1–3 switch the modes, so Tidy's pages take ⌥⌘1–7.
    view: views.map(
      ([label, command], index): MenuItemConstructorOptions => ({
        label,
        accelerator: `Alt+CmdOrCtrl+${index + 1}`,
        click: () => send(command),
      }),
    ),
    settings: { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
    help: [{ label: "Keyboard Shortcuts", click: () => send("shortcuts") }],
  };
}

/**
 * Starts Tidy, Glazier as one of Oriel's modes. Its IPC and media protocol are ready at once,
 * since its window can call them as soon as it mounts; the engine process starts with the first
 * call, and the hidden transcoder window when the owner first opens Tidy.
 */
export function startTidy({ dataDir, window, onProgress, packaged }: TidyOptions): ModeHost {
  const changes = new Map<Job["id"], Job>();

  const host = new EngineHost({
    dataDir,
    packaged,
    onEvent: (event) => {
      if (event.kind === "job") {
        if (isRunningChange(event.job)) {
          changes.set(event.job.id, event.job);
        } else {
          changes.delete(event.job.id);
        }

        const running = [...changes.values()].find((job) => job.state === "running");

        onProgress(
          changes.size === 0
            ? null
            : running && running.total > 0
              ? running.done / running.total
              : 0,
        );
      }

      window()?.webContents.send(RendererChannels.event, event);
    },
  });

  handleMediaProtocol(host);
  registerIpc(host, window);

  let started = false;

  return {
    busy: () => changes.size > 0,
    menu: tidyMenu((command) => window()?.webContents.send(RendererChannels.command, command)),
    activate: () => {
      if (started) {
        return;
      }

      started = true;
      void host.start().catch((error: Error) => {
        console.error(`[oriel:tidy] the engine did not start: ${error.message}`);
      });
    },
    dispose: () => host.dispose(),
  };
}
