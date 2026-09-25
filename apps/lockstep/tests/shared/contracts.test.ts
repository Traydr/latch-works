import { describe, expect, it } from "vitest";

import { LockstepProfilePatchSchema } from "../../src/shared/contracts";

describe("LockstepProfilePatchSchema", () => {
  it("applies creation's rules to edited fields", () => {
    expect(LockstepProfilePatchSchema.safeParse({ name: "" }).success).toBe(false);
    expect(LockstepProfilePatchSchema.safeParse({ apiUrl: "" }).success).toBe(false);
    expect(LockstepProfilePatchSchema.safeParse({ sourceRoot: "" }).success).toBe(false);
    expect(LockstepProfilePatchSchema.safeParse({ name: 42 }).success).toBe(false);
  });

  it("accepts a partial edit and an empty token as keep", () => {
    expect(LockstepProfilePatchSchema.safeParse({ name: "Renamed", token: "" }).success).toBe(true);
  });

  it("rejects replacing and clearing the token at once", () => {
    expect(LockstepProfilePatchSchema.safeParse({ clearToken: true, token: "new" }).success).toBe(
      false,
    );
    expect(LockstepProfilePatchSchema.safeParse({ clearToken: true }).success).toBe(true);
  });
});
