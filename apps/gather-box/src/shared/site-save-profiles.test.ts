import { describe, expect, it } from "vitest";
import { getSiteSaveProfile, SITE_SAVE_PROFILES } from "./site-save-profiles";
import type { SiteKey } from "./sites";

const ALL_SITE_KEYS: SiteKey[] = [
  "myhentaigallery",
  "kemono",
  "fanbox",
  "archiveofourown",
  "hentaifoundry-stories",
  "fanfiction-net"
];

describe("site-save-profiles", () => {
  it("defines a profile for every supported site key", () => {
    expect(SITE_SAVE_PROFILES).toHaveLength(ALL_SITE_KEYS.length);

    for (const siteKey of ALL_SITE_KEYS) {
      const profile = getSiteSaveProfile(siteKey);
      expect(profile.key).toBe(siteKey);
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.saveRuleSummary.length).toBeGreaterThan(0);
      expect(profile.folderPattern.length).toBeGreaterThan(0);
      expect(profile.folderExample.length).toBeGreaterThan(0);
    }
  });

  it("classifies gallery sites with nested or post folders", () => {
    expect(getSiteSaveProfile("kemono").folderStrategy).toBe("creator-nested");
    expect(getSiteSaveProfile("fanbox").folderStrategy).toBe("creator-nested");
    expect(getSiteSaveProfile("myhentaigallery").folderStrategy).toBe("post-folder");
  });

  it("classifies story sites as flat PDF output", () => {
    for (const siteKey of ["archiveofourown", "hentaifoundry-stories", "fanfiction-net"] as const) {
      expect(getSiteSaveProfile(siteKey).folderStrategy).toBe("flat");
    }
  });
});
