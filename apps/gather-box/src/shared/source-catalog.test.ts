import { describe, expect, it } from "vitest";
import { GATHER_SOURCES } from "./source-catalog";

describe("Gather Source catalog", () => {
  it("owns every HTTPS permission with a reason", () => {
    for (const source of GATHER_SOURCES) {
      for (const permission of source.hostPermissions) {
        expect(permission.pattern, source.key).toMatch(/^https:\/\//);
        expect(permission.pattern, source.key).not.toBe("https://*/*");
        expect(permission.reason.trim(), source.key).not.toBe("");
      }
    }
  });
});
