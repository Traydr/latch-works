import { describe, expect, it } from "vitest";
import {
  getMissingFields,
  type MissingField,
  mergeWithConfigAndEnv,
  parseArgv,
} from "./options.js";
import type { CliOptions } from "./types.js";

describe("parseArgv", () => {
  it("detects empty argv", () => {
    expect(parseArgv([])).toEqual({ kind: "empty" });
  });

  it("detects help requests", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseArgv(["help"])).toEqual({ kind: "help" });
    expect(parseArgv(["plan", "--help"])).toEqual({ kind: "help" });
  });

  it("parses plan flags", () => {
    const result = parseArgv(["plan", "--source", "D:\\media", "--hash", "--show-skipped"]);
    expect(result).toEqual({
      kind: "parsed",
      options: {
        apiTokenEnv: "LOCKSTEP_API_TOKEN",
        command: "plan",
        hashFiles: true,
        showSkipped: true,
        yes: false,
        source: "D:\\media",
      },
    });
  });

  it("parses push --yes", () => {
    const result = parseArgv(["push", "--source", "D:\\media", "--yes", "--max-changes", "10"]);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") {
      return;
    }

    expect(result.options).toMatchObject({
      command: "push",
      source: "D:\\media",
      yes: true,
      maxChanges: 10,
    });
  });
});

describe("mergeWithConfigAndEnv", () => {
  it("prefers explicit CLI values over env and config", () => {
    const options: CliOptions = {
      apiTokenEnv: "LOCKSTEP_API_TOKEN",
      command: "plan",
      hashFiles: false,
      showSkipped: false,
      yes: false,
      source: "D:\\cli",
    };

    const merged = mergeWithConfigAndEnv(
      options,
      { source: "D:\\config", defaults: { hashFiles: true, showSkipped: true } },
      { LOCKSTEP_SOURCE: "D:\\env" },
    );

    expect(merged.source).toBe("D:\\cli");
    expect(merged.hashFiles).toBe(true);
    expect(merged.showSkipped).toBe(true);
  });

  it("falls back to env then config", () => {
    const options: CliOptions = {
      apiTokenEnv: "LOCKSTEP_API_TOKEN",
      command: "push",
      hashFiles: false,
      showSkipped: false,
      yes: false,
    };

    const merged = mergeWithConfigAndEnv(
      options,
      { source: "D:\\config", apiUrl: "https://config.test" },
      { LOCKSTEP_SOURCE: "D:\\env", LOCKSTEP_API_URL: "https://env.test" },
    );

    expect(merged.source).toBe("D:\\env");
    expect(merged.apiUrl).toBe("https://env.test");
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
