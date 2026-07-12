import { describe, expect, it } from "vitest";
import {
  decodeCapabilityKeyMaterial,
  listCapabilityKeyIds,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  unwrapEnvJson,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = Buffer.from(KEY).toString("base64url");
const hexKey = "b0573018577c75f337fee083e513b588b24f1a46dd4831702bd5a4416aaf7766";
const railwayCapabilityKeys = `{
  "ernesta": {
    "key-id": "e9fc8797aeb1921b9e48087e67ad8c6e8ce27af0b6ef43d2f54d24b968668f1a"
  },
  "pane-view": {
    "key-id": "${hexKey}"
  }
}`;

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

  it("accepts Railway multiline JSON with hex-encoded key material", () => {
    expect(
      validateCapabilityKeyConfig({
        capabilityKeys: railwayCapabilityKeys,
        capabilityKid: "key-id",
        spaceId: "pane-view",
      }),
    ).toEqual({ ok: true, kid: "key-id", spaceId: "pane-view" });
  });

  it("decodes 64-char hex secrets to 32-byte keys", () => {
    expect(decodeCapabilityKeyMaterial(hexKey)).toHaveLength(32);
  });

  it("rejects using the hex secret as SHUTTER_CAPABILITY_KID", () => {
    const status = validateCapabilityKeyConfig({
      capabilityKeys: railwayCapabilityKeys,
      capabilityKid: hexKey,
      spaceId: "pane-view",
    });

    expect(status.ok).toBe(false);
    if (status.ok) throw new Error("expected invalid status");
    expect(status.error).toContain(
      'key ID "b0573018577c75f337fee083e513b588b24f1a46dd4831702bd5a4416aaf7766"',
    );
    expect(status.error).toContain('nested["pane-view"]: key-id');
  });
});
