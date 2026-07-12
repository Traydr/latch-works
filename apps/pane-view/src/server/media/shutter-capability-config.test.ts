import { describe, expect, it } from "vitest";
import {
  listCapabilityKeyIds,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  unwrapEnvJson,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = Buffer.from(KEY).toString("base64url");

describe("shutter capability config", () => {
  it("unwraps single-quoted JSON copied from .env examples", () => {
    expect(unwrapEnvJson(`'{"pane-view":{"kid":"${encodedKey}"}}'`)).toBe(
      `{"pane-view":{"kid":"${encodedKey}"}}`,
    );
  });

  it("reads nested and flat registry layouts", () => {
    const nested = parseCapabilityKeyRegistry(
      JSON.stringify({ "pane-view": { "active-key": encodedKey } }),
    );
    const flat = parseCapabilityKeyRegistry(JSON.stringify({ "active-key": encodedKey }));

    expect(readCapabilityKeyMaterial(nested, "pane-view", "active-key")).toBe(encodedKey);
    expect(readCapabilityKeyMaterial(flat, "pane-view", "active-key")).toBe(encodedKey);
  });

  it("lists nested and flat key ids for diagnostics", () => {
    const registry = parseCapabilityKeyRegistry(
      JSON.stringify({
        "pane-view": { nested: encodedKey },
        flat: encodedKey,
      }),
    );

    expect(listCapabilityKeyIds(registry, "pane-view")).toEqual({
      nestedKids: ["nested"],
      flatKids: ["flat"],
    });
  });

  it("reports which key ids are available when the active kid is missing", () => {
    const status = validateCapabilityKeyConfig({
      capabilityKeys: JSON.stringify({ "pane-view": { "other-key": encodedKey } }),
      capabilityKid: "missing-key",
      spaceId: "pane-view",
    });

    expect(status.ok).toBe(false);
    if (status.ok) throw new Error("expected invalid status");
    expect(status.error).toContain('key ID "missing-key" is not active');
    expect(status.error).toContain('nested["pane-view"]: other-key');
  });

  it("accepts a valid nested registry", () => {
    expect(
      validateCapabilityKeyConfig({
        capabilityKeys: JSON.stringify({ "pane-view": { "active-key": encodedKey } }),
        capabilityKid: "active-key",
        spaceId: "pane-view",
      }),
    ).toEqual({ ok: true, kid: "active-key", spaceId: "pane-view" });
  });
});
