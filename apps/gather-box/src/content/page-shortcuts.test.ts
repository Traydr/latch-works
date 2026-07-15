// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_EXTENSION_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE
} from "../shared/runtime-messages";
import { installPageShortcuts } from "./page-shortcuts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gather Box page shortcuts", () => {
  it("toggles Gather Box from the physical Right Shift + ] keys", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });

    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    const shortcut = pressKey({ code: "BracketRight", key: "]", shiftKey: true });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({
      type: OPEN_EXTENSION_MESSAGE,
      target: "background"
    });
    uninstall();
  });

  it("starts downloading from the physical Right Shift + [ keys", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });

    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    pressKey({ code: "BracketLeft", key: "[", shiftKey: true });

    expect(sendMessage).toHaveBeenCalledWith({
      type: TRIGGER_DOWNLOAD_MESSAGE,
      target: "background"
    });
    uninstall();
  });

  it("does not react to Left Shift or a released Right Shift", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });

    pressKey({ code: "ShiftLeft", key: "Shift", shiftKey: true });
    pressKey({ code: "BracketRight", key: "}", shiftKey: true });
    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    releaseKey({ code: "ShiftRight", key: "Shift" });
    pressKey({ code: "BracketLeft", key: "{", shiftKey: true });

    expect(sendMessage).not.toHaveBeenCalled();
    uninstall();
  });

  it("resets held Shift on blur and ignores repeat events", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });
    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    window.dispatchEvent(new Event("blur"));
    pressKey({ code: "BracketRight", key: "]", shiftKey: true });
    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    pressKey({ code: "BracketRight", key: "]", shiftKey: true, repeat: true });
    expect(sendMessage).not.toHaveBeenCalled();
    uninstall();
  });

  it("does not intercept shortcuts typed into editable controls", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ShiftRight", key: "Shift", bubbles: true })
    );
    const shortcut = new KeyboardEvent("keydown", {
      code: "BracketRight",
      key: "]",
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    input.remove();
    uninstall();
  });

  it("accepts key and location when the browser does not report physical codes", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage });

    pressKey({ code: "", key: "Shift", location: 2 });
    pressKey({ code: "", key: "]" });

    expect(sendMessage).toHaveBeenCalledWith({
      type: OPEN_EXTENSION_MESSAGE,
      target: "background"
    });
    uninstall();
  });

  it("does not intercept shortcuts when they are disabled", () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const uninstall = installPageShortcuts(document, { sendMessage }, () => ({
      enabled: false
    }));

    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    const shortcut = pressKey({ code: "BracketRight", key: "]", shiftKey: true });

    expect(shortcut.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    uninstall();
  });

  it("ignores a synchronous send failure from an invalidated extension context", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("Extension context invalidated.");
    });
    const uninstall = installPageShortcuts(document, { sendMessage });

    pressKey({ code: "ShiftRight", key: "Shift", shiftKey: true });
    expect(() => pressKey({ code: "BracketRight", key: "]", shiftKey: true })).not.toThrow();
    const nextShortcut = pressKey({ code: "BracketRight", key: "]", shiftKey: true });
    expect(nextShortcut.defaultPrevented).toBe(false);

    uninstall();
  });
});

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

function releaseKey(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent("keyup", { ...init, bubbles: true }));
}
