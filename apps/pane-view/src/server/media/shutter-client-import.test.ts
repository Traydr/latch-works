import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShutterClientDependencies, ShutterEnvironment } from "./shutter-client";

/**
 * The capability registry must stay evaluated lazily: importing the client
 * module may not read it, or a misconfigured deployment fails at boot rather
 * than at the first media request. The misconfiguration warning is the
 * observable side effect of that evaluation.
 */

/** No registry and no key id, so any evaluation reports a misconfiguration. */
const environment: ShutterEnvironment = {
  SHUTTER_CAPABILITY_KEYS: "",
  SHUTTER_CAPABILITY_KID: "",
  SHUTTER_CONTROL_URL: "https://control.shutter.test",
  SHUTTER_EDGE_URL: "https://edge.shutter.test",
  SHUTTER_SPACE_API_TOKEN: "",
  SHUTTER_SPACE_ID: "pane-view",
};

const dependencies: ShutterClientDependencies = {
  createSourceLocator: async () => "https://storage.test/original?signature=test",
  environment,
};

const image = {
  extension: "jpg",
  mediaObjectId: "object-1",
  mediaType: "image" as const,
  originalObjectKey: "originals/image.jpg",
  sha256: "a".repeat(64),
};

describe("Shutter client import", () => {
  beforeEach(() => {
    // A fresh module, so the once-per-process capability check is unarmed.
    vi.resetModules();
  });

  it("does not evaluate capability configuration during module import", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = await import("./shutter-client");
    expect(reported).not.toHaveBeenCalled();

    // The first resolve is what evaluates the registry, and reports it once.
    await expect(client.resolveShutterImageUrl(image, 320, dependencies)).rejects.toThrow();
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]?.[0]).toContain("Shutter capability keys misconfigured");

    await expect(client.resolveShutterImageUrl(image, 320, dependencies)).rejects.toThrow();
    expect(reported).toHaveBeenCalledTimes(1);

    reported.mockRestore();
  });
});
