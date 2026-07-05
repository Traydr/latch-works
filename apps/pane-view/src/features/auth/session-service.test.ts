import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/auth/web-session-core", () => ({
  isRequestSessionValid: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

import { getRequest } from "@tanstack/react-start/server";
import { isRequestSessionValid } from "../../server/auth/web-session-core";
import { readSessionStatus } from "./session-service";

describe("session auth", () => {
  beforeEach(() => {
    vi.mocked(isRequestSessionValid).mockReset();
    vi.mocked(getRequest).mockReset();
    vi.mocked(getRequest).mockReturnValue(new Request("http://localhost/"));
  });

  it("returns authenticated: false for unauthenticated requests", async () => {
    vi.mocked(isRequestSessionValid).mockResolvedValue(false);

    const result = await readSessionStatus();

    expect(result).toEqual({ authenticated: false });
  });

  it("returns authenticated: true for authenticated requests", async () => {
    vi.mocked(isRequestSessionValid).mockResolvedValue(true);

    const result = await readSessionStatus();

    expect(result).toEqual({ authenticated: true });
  });
});
