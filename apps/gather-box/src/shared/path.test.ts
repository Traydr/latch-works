import { describe, expect, it } from "vitest";
import { sanitizeFileName, sanitizePathSegment } from "./path";

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
});
