import { redirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCurrentWebSessionValid } from "@/server/auth/web-session";
import { requireCurrentWebSession } from "./web-session-guard";

vi.mock("@/server/auth/web-session", () => ({
  isCurrentWebSessionValid: vi.fn(),
}));

describe("requireCurrentWebSession", () => {
  beforeEach(() => {
    vi.mocked(isCurrentWebSessionValid).mockReset();
  });

  it("allows valid web sessions", async () => {
    vi.mocked(isCurrentWebSessionValid).mockResolvedValue(true);

    await expect(requireCurrentWebSession()).resolves.toBeUndefined();
  });

  it("redirects invalid web sessions to login", async () => {
    vi.mocked(isCurrentWebSessionValid).mockResolvedValue(false);

    await expect(requireCurrentWebSession()).rejects.toEqual(redirect({ to: "/login" }));
  });
});
