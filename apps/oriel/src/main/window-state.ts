import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BrowserWindow } from "electron";
import { z } from "zod";

const WindowStateSchema = z.object({
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  maximized: z.boolean(),
});

export type WindowState = z.infer<typeof WindowStateSchema>;

const FILE_NAME = "window-state.json";

/** The window's last size, position and whether it was maximized, or null before the first close. */
export function readWindowState(dataDir: string): WindowState | null {
  try {
    const parsed = WindowStateSchema.safeParse(
      JSON.parse(readFileSync(path.join(dataDir, FILE_NAME), "utf8")),
    );

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the window's size and position as it changes, a moment after the last change, and
 * once more as it closes. A maximized window keeps its normal bounds for when it is restored.
 */
export function rememberWindowState(window: BrowserWindow, dataDir: string): void {
  let timer: NodeJS.Timeout | null = null;

  const save = () => {
    if (window.isDestroyed()) {
      return;
    }

    const state: WindowState = {
      bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(),
      maximized: window.isMaximized(),
    };

    try {
      writeFileSync(path.join(dataDir, FILE_NAME), JSON.stringify(state));
    } catch (error) {
      console.warn(
        `[oriel:main] window state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const saveSoon = () => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      save();
    }, 250);
  };

  window.on("resize", saveSoon);
  window.on("move", saveSoon);
  window.on("maximize", save);
  window.on("unmaximize", save);
  window.on("close", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    save();
  });
}
