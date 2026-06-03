import { describe, expect, it } from "vitest";
import { verifySingleUserCredentials } from "./session";

describe("single-user credential helpers", () => {
  it("verifies configured credentials", () => {
    const env = {
      PANE_VIEW_PASSWORD: "secret",
      PANE_VIEW_USERNAME: "traydr",
    };

    expect(verifySingleUserCredentials({ env, password: "secret", username: "traydr" })).toBe(true);
    expect(verifySingleUserCredentials({ env, password: "wrong", username: "traydr" })).toBe(false);
  });
});
