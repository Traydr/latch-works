import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";
import { describe, expect, it } from "vitest";
import {
  derivativeQueueVariantForRequestedSize,
  resolveDerivativeQueuePriority,
} from "./derivative-priority";

describe("resolveDerivativeQueuePriority", () => {
  it("prioritizes demand before prewarm and previews before thumbnails", () => {
    expect(resolveDerivativeQueuePriority({ source: "on-demand", variant: "preview" })).toBe(300);
    expect(resolveDerivativeQueuePriority({ source: "on-demand", variant: "thumbnail" })).toBe(200);
    expect(resolveDerivativeQueuePriority({ source: "prewarm", variant: "preview" })).toBe(100);
    expect(resolveDerivativeQueuePriority({ source: "prewarm", variant: "thumbnail" })).toBe(0);
  });
});

describe("derivativeQueueVariantForRequestedSize", () => {
  it("treats the fixed preview size as preview demand", () => {
    expect(derivativeQueueVariantForRequestedSize(PREVIEW_DERIVATIVE_SIZE)).toBe("preview");
  });

  it("treats the gallery size as thumbnail demand", () => {
    expect(derivativeQueueVariantForRequestedSize(GALLERY_THUMBNAIL_SIZE)).toBe("thumbnail");
  });
});
