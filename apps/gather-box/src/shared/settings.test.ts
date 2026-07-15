import { describe, expect, it } from "vitest";
import { normalizeSettings } from "./settings";

describe("Gather Box shortcut settings", () => {
  it("enables shortcuts by default for existing settings", () => {
    expect(normalizeSettings({}).pageShortcutsEnabled).toBe(true);
  });

  it("preserves an explicitly disabled shortcut setting", () => {
    expect(
      normalizeSettings({ shortcutsEnabled: false } as never).pageShortcutsEnabled
    ).toBe(false);
  });

  it("prefers the explicit page-shortcut setting over the legacy field", () => {
    expect(
      normalizeSettings({ pageShortcutsEnabled: true, shortcutsEnabled: false } as never)
        .pageShortcutsEnabled
    ).toBe(true);
  });
});
