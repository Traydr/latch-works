import { describe, expect, it } from "vitest";
import { buildBunnyLwImageTransformUrl } from "./image-delivery-client";

describe("buildBunnyLwImageTransformUrl", () => {
  it("forces Bunny image optimization for low-res placeholders", () => {
    const transformed = new URL(
      buildBunnyLwImageTransformUrl("https://cdn.example.com/lw/token", {
        aspect_ratio: "24:24",
        height: 24,
        width: 24,
      }),
    );

    expect(transformed.searchParams.get("width")).toBe("24");
    expect(transformed.searchParams.get("height")).toBe("24");
    expect(transformed.searchParams.get("aspect_ratio")).toBe("24:24");
    expect(transformed.searchParams.get("optimizer")).toBe("image");
    expect(transformed.searchParams.get("output")).toBe("webp");
    expect(transformed.searchParams.get("quality")).toBe("30");
    expect(transformed.searchParams.get("blur")).toBe("24");
  });

  it("uses gallery thumbnail defaults for normal image candidates", () => {
    const transformed = new URL(
      buildBunnyLwImageTransformUrl("https://cdn.example.com/lw/token", {
        format: "webp",
        height: 480,
        width: 640,
      }),
    );

    expect(transformed.searchParams.get("width")).toBe("640");
    expect(transformed.searchParams.get("height")).toBe("480");
    expect(transformed.searchParams.get("aspect_ratio")).toBe("640:480");
    expect(transformed.searchParams.get("optimizer")).toBe("image");
    expect(transformed.searchParams.get("output")).toBe("webp");
    expect(transformed.searchParams.get("quality")).toBe("75");
    expect(transformed.searchParams.has("blur")).toBe(false);
  });
});
