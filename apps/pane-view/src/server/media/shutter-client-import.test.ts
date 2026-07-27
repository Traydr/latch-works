import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateCapabilityKeyConfig: vi.fn(() => ({ ok: true as const })),
}));

vi.mock("../../env/server", () => ({
  env: {
    SHUTTER_CAPABILITY_KEYS: "",
    SHUTTER_CAPABILITY_KID: "",
    SHUTTER_CONTROL_URL: "https://control.shutter.test",
    SHUTTER_EDGE_URL: "https://edge.shutter.test",
    SHUTTER_SPACE_API_TOKEN: "",
    SHUTTER_SPACE_ID: "pane-view",
  },
}));
vi.mock("./shutter-capability-config", () => ({
  decodeCapabilityKeyMaterial: vi.fn(),
  parseCapabilityKeyRegistry: vi.fn(),
  readCapabilityKeyMaterial: vi.fn(),
  validateCapabilityKeyConfig: mocks.validateCapabilityKeyConfig,
}));
vi.mock("./storage-client", () => ({ createPaneViewStorageClient: vi.fn() }));

describe("Shutter client import", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.validateCapabilityKeyConfig.mockClear();
  });

  it("does not evaluate capability configuration during module import", async () => {
    await import("./shutter-client");

    expect(mocks.validateCapabilityKeyConfig).not.toHaveBeenCalled();
  });
});
