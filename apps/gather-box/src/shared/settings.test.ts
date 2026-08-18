import { describe, expect, it } from "vitest";
import { GatherBoxSettingsSchema } from "./settings";

describe("Gather Box shortcut settings", () => {
  it("keeps archive media conversion off by default", () => {
    expect(GatherBoxSettingsSchema.parse({}).mediaCompatibilityMode).toBe(false);
  });

  it("preserves an enabled archive media conversion setting", () => {
    expect(
      GatherBoxSettingsSchema.parse({ mediaCompatibilityMode: true }).mediaCompatibilityMode
    ).toBe(true);
  });

  it("enables shortcuts by default for existing settings", () => {
    expect(GatherBoxSettingsSchema.parse({}).pageShortcutsEnabled).toBe(true);
  });

  it("preserves an explicitly disabled shortcut setting", () => {
    expect(GatherBoxSettingsSchema.parse({ shortcutsEnabled: false }).pageShortcutsEnabled).toBe(
      false
    );
  });

  it("prefers the explicit page-shortcut setting over the legacy field", () => {
    expect(
      GatherBoxSettingsSchema.parse({ pageShortcutsEnabled: true, shortcutsEnabled: false })
        .pageShortcutsEnabled
    ).toBe(true);
  });

  it("drops credential overrides for unknown persisted source keys", () => {
    expect(
      GatherBoxSettingsSchema.parse({
        credentialsPerSite: { pixiv: "omit", invented: "include" }
      }).credentialsPerSite
    ).toEqual({ pixiv: "omit" });
  });

  it("falls back to defaults when the stored value is not a settings record", () => {
    expect(GatherBoxSettingsSchema.parse("not-settings")).toEqual({
      downloadConcurrency: 4,
      mediaCompatibilityMode: false,
      useGlobalFolder: false,
      verboseLogging: false,
      pageShortcutsEnabled: true,
      credentialsMode: "auto",
      credentialsPerSite: {}
    });
  });
});
