import { describe, expect, it } from "vitest";
import { isSystemJunkDirectory, isSystemJunkFile } from "./system-files.js";

describe("isSystemJunkFile", () => {
  it("matches common OS metadata files", () => {
    expect(isSystemJunkFile(".DS_Store")).toBe(true);
    expect(isSystemJunkFile("Thumbs.db")).toBe(true);
    expect(isSystemJunkFile("desktop.ini")).toBe(true);
    expect(isSystemJunkFile("ehthumbs.db")).toBe(true);
    expect(isSystemJunkFile("ehthumbs_vista.db")).toBe(true);
  });

  it("matches AppleDouble resource fork files", () => {
    expect(isSystemJunkFile("._photo.jpg")).toBe(true);
  });

  it("does not match regular media files", () => {
    expect(isSystemJunkFile("photo.jpg")).toBe(false);
    expect(isSystemJunkFile("notes.txt")).toBe(false);
  });
});

describe("isSystemJunkDirectory", () => {
  it("matches common OS metadata directories", () => {
    expect(isSystemJunkDirectory("__MACOSX")).toBe(true);
    expect(isSystemJunkDirectory(".Trashes")).toBe(true);
    expect(isSystemJunkDirectory("$RECYCLE.BIN")).toBe(true);
    expect(isSystemJunkDirectory("System Volume Information")).toBe(true);
  });

  it("does not match regular archive folders", () => {
    expect(isSystemJunkDirectory("photos")).toBe(false);
    expect(isSystemJunkDirectory("2024")).toBe(false);
  });
});
