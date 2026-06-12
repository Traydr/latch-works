import { describe, expect, it, vi } from "vitest";

vi.mock("../../env/server", () => ({
  env: {
    MEDIA_DELIVERY_SECRET: "test-delivery-secret-32-characters",
    MEDIA_DELIVERY_TTL_SECONDS: 86_400,
  },
}));

import { buildCdnCacheControl } from "./cdn-delivery";

describe("buildCdnCacheControl", () => {
  it("returns public cache control bounded by ttl", () => {
    const header = buildCdnCacheControl(3600);

    expect(header).toBe("public, max-age=3600");
    expect(header).not.toContain("immutable");
  });
});
