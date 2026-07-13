import { describe, expect, it } from "vitest";
import { normalizeSettings } from "./settings";

describe("Gather Box shortcut settings", () => {
  it("enables shortcuts by default for existing settings", () => {
    expect(normalizeSettings({}).shortcutsEnabled).toBe(true);
  });

  it("preserves an explicitly disabled shortcut setting", () => {
    expect(normalizeSettings({ shortcutsEnabled: false }).shortcutsEnabled).toBe(false);
  });
});
