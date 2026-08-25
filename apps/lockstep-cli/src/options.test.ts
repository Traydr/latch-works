import { describe, expect, it } from "vitest";
import { getMissingFields, type MissingField, parseArgv } from "./options.js";
import type { CliOptions } from "./types.js";

describe("parseArgv", () => {
  it("parses push --upload-concurrency bounds", () => {
    const result = parseArgv(["push", "--source", "D:\\media", "--upload-concurrency", "3"]);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") {
      return;
    }
    expect(result.options.uploadConcurrency).toBe(3);
  });

  it("rejects invalid --upload-concurrency values", () => {
    expect(() => parseArgv(["push", "--upload-concurrency", "0"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
    expect(() => parseArgv(["push", "--upload-concurrency", "9"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
    expect(() => parseArgv(["push", "--upload-concurrency", "1.5"])).toThrow(
      "--upload-concurrency must be an integer between 1 and 8.",
    );
  });
});

describe("getMissingFields", () => {
  const base: CliOptions = {
    apiTokenEnv: "LOCKSTEP_API_TOKEN",
    command: "plan",
    hashFiles: false,
    showSkipped: false,
    yes: false,
  };

  it("requires source for plan", () => {
    expect(getMissingFields(base)).toEqual<MissingField[]>(["source"]);
  });

  it("requires remote snapshot for verify", () => {
    expect(
      getMissingFields({
        ...base,
        command: "verify",
        source: "D:\\media",
      }),
    ).toEqual(["remoteSnapshot"]);
  });

  it("requires api URL for push when not in env", () => {
    expect(
      getMissingFields({
        ...base,
        command: "push",
        source: "D:\\media",
      }),
    ).toEqual(["apiUrl"]);
  });

  it("does not require push confirmation for scripted push", () => {
    expect(
      getMissingFields(
        {
          ...base,
          command: "push",
          source: "D:\\media",
          apiUrl: "http://localhost:3000",
        },
        {},
      ),
    ).toEqual([]);
  });
});
