import { describe, expect, it } from "vitest";
import { readSingleUserCredentials, verifySingleUserCredentials } from "./session";

describe("single-user credential helpers", () => {
  it("verifies configured credentials", () => {
    const credentials = readSingleUserCredentials();

    expect(
      verifySingleUserCredentials({
        password: credentials.password,
        username: credentials.username,
      }),
    ).toBe(true);
    expect(
      verifySingleUserCredentials({
        password: "wrong",
        username: credentials.username,
      }),
    ).toBe(false);
  });
});
