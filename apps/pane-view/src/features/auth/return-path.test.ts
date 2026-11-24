import { describe, expect, it } from "vitest";
import { safeReturnPath, signInHref } from "./return-path";

describe("safeReturnPath", () => {
  it("keeps a path on this site with its search and hash", () => {
    expect(safeReturnPath("/?path=mixed&media=abc#top")).toBe("/?path=mixed&media=abc#top");
    expect(safeReturnPath("/stats")).toBe("/stats");
  });

  it("returns to the gallery for anything that could leave the site", () => {
    for (const candidate of [
      "https://example.com/",
      "//example.com/",
      "/\\example.com/",
      "\\\\example.com/",
      "javascript:alert(1)",
      "stats",
      "",
      null,
      undefined,
    ]) {
      expect(safeReturnPath(candidate), String(candidate)).toBe("/");
    }
  });

  it("returns to the gallery instead of an endpoint or the login page", () => {
    expect(safeReturnPath("/api/media/1/original")).toBe("/");
    expect(safeReturnPath("/_serverFn/abc")).toBe("/");
    expect(safeReturnPath("/login?redirect=/stats")).toBe("/");
  });
});

describe("signInHref", () => {
  it("carries the page to come back to", () => {
    expect(signInHref("/?path=mixed")).toBe("/login?redirect=%2F%3Fpath%3Dmixed");
  });

  it("leaves the gallery's root and unsafe paths out", () => {
    expect(signInHref("/")).toBe("/login");
    expect(signInHref("//example.com")).toBe("/login");
    expect(signInHref("/", "invalid")).toBe("/login?error=invalid");
  });
});
