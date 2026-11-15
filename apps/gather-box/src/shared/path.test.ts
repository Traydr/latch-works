import { describe, expect, it } from "vitest";
import { lowercaseFirstAscii, sanitizeFileName, sanitizePathSegment } from "./path";

describe("ASCII name normalization", () => {
  it("lowercases only an initial ASCII capital", () => {
    expect(lowercaseFirstAscii("Artist_Name")).toBe("artist_Name");
    expect(lowercaseFirstAscii("_Artist")).toBe("_Artist");
    expect(lowercaseFirstAscii("éArtist")).toBe("éArtist");
  });
});

describe("path sanitization", () => {
  it("rejects dot and parent directory segments", () => {
    expect(sanitizePathSegment(".")).toBe("");
    expect(sanitizePathSegment("..")).toBe("");
    expect(sanitizePathSegment(" . ")).toBe("");
    expect(sanitizePathSegment(" .. ")).toBe("");
  });

  it("still sanitizes ordinary titles", () => {
    expect(sanitizePathSegment("My Comic!")).toBe("My_Comic!");
    expect(sanitizeFileName("../../evil name?.jpg")).toBe("evil_name_.jpg");
  });

  it("drops the edge tildes and control characters Chrome refuses in names", () => {
    expect(sanitizePathSegment("How about we get it on?~")).toBe("How_about_we_get_it_on_");
    expect(sanitizePathSegment("~draft~.")).toBe("draft");
    expect(sanitizePathSegment("a\u0007b")).toBe("a_b");
    expect(sanitizeFileName("~notes~.txt~")).toBe("notes~.txt");
  });

  it("preserves trailing underscores used by X usernames", () => {
    expect(sanitizePathSegment(lowercaseFirstAscii("ILIE_ILIE_"))).toBe("iLIE_ILIE_");
    expect(sanitizePathSegment("ILIE_ILIE_.")).toBe("ILIE_ILIE_");
  });
});
