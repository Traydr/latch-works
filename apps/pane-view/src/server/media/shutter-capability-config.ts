import { z } from "zod";
import { parseJsonWith } from "@/lib/parse-json";

/** Encoded key material: 64 hex characters or base64url; decoded by decodeCapabilityKeyMaterial. */
const KeyMaterialSchema = z.string();
const SpaceKeyMapSchema = z.record(z.string(), KeyMaterialSchema);

/** One top-level registry entry: key material (flat layout) or a space's kid → material map. */
const RegistryEntrySchema = z.union([
  KeyMaterialSchema.transform((material) => ({ kind: "flat" as const, material })),
  SpaceKeyMapSchema.transform((keys) => ({ kind: "space" as const, keys })),
]);

/** The registry after parsing: flat kids and per-space kids kept apart. */
export interface CapabilityKeyRegistry {
  flat: Record<string, string>;
  spaces: Record<string, Record<string, string>>;
}

/**
 * SHUTTER_CAPABILITY_KEYS: either flat (`{ kid: material }`) or nested per
 * space (`{ spaceId: { kid: material } }`); the two layouts may be mixed.
 */
export const CapabilityKeyRegistrySchema = z
  .record(z.string(), RegistryEntrySchema)
  .transform((entries): CapabilityKeyRegistry => {
    const registry: CapabilityKeyRegistry = { flat: {}, spaces: {} };
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.kind === "flat") {
        registry.flat[key] = entry.material;
      } else {
        registry.spaces[key] = entry.keys;
      }
    }
    return registry;
  });

/** The registry as it arrives from the environment: JSON, or JSON encoded once more as a string. */
const CapabilityKeyRegistryEnvSchema = z.union([
  CapabilityKeyRegistrySchema,
  z.string().transform((text, context) => {
    const registry = parseJsonWith(text, CapabilityKeyRegistrySchema);
    if (registry === null) {
      context.issues.push({ code: "custom", input: text, message: "not a key registry" });
      return z.NEVER;
    }
    return registry;
  }),
]);

export type CapabilityKeyConfigStatus =
  | { ok: true; kid: string; spaceId: string }
  | { ok: false; kid: string; spaceId: string; error: string };

export interface CapabilityKeyIds {
  flatKids: string[];
  nestedKids: string[];
}

export function unwrapEnvJson(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function unwrapEnvScalar(raw: string): string {
  return unwrapEnvJson(raw).trim();
}

/** Throws when the value is not JSON or does not fit the registry layouts. */
export function parseCapabilityKeyRegistry(raw: string): CapabilityKeyRegistry {
  const registry = parseJsonWith(unwrapEnvJson(raw), CapabilityKeyRegistryEnvSchema);
  if (registry === null) {
    throw new SyntaxError("Invalid capability key registry");
  }
  return registry;
}

export function decodeCapabilityKeyMaterial(encoded: string): Uint8Array<ArrayBuffer> {
  const trimmed = encoded.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  return Uint8Array.from(Buffer.from(trimmed, "base64url"));
}

export function listCapabilityKeyIds(
  registry: CapabilityKeyRegistry,
  spaceId: string,
): CapabilityKeyIds {
  return {
    flatKids: Object.keys(registry.flat).sort(),
    nestedKids: Object.keys(registry.spaces[spaceId] ?? {}).sort(),
  };
}

export function readCapabilityKeyMaterial(
  registry: CapabilityKeyRegistry,
  spaceId: string,
  kid: string,
): string | undefined {
  return registry.spaces[spaceId]?.[kid] ?? registry.flat[kid];
}

function formatRegistryHint(registry: CapabilityKeyRegistry, spaceId: string): string {
  const { flatKids, nestedKids } = listCapabilityKeyIds(registry, spaceId);
  const parts: string[] = [];
  if (nestedKids.length > 0) {
    parts.push(`nested["${spaceId}"]: ${nestedKids.join(", ")}`);
  }
  if (flatKids.length > 0) {
    parts.push(`flat: ${flatKids.join(", ")}`);
  }
  if (parts.length === 0) {
    return "registry contains no capability key IDs";
  }
  return `available key IDs — ${parts.join("; ")}`;
}

export function validateCapabilityKeyConfig({
  capabilityKeys,
  capabilityKid,
  spaceId,
}: {
  capabilityKeys: string;
  capabilityKid: string;
  spaceId: string;
}): CapabilityKeyConfigStatus {
  const kid = unwrapEnvScalar(capabilityKid);
  const normalizedSpaceId = unwrapEnvScalar(spaceId);

  if (!capabilityKeys.trim() || !kid) {
    return {
      ok: false,
      kid,
      spaceId: normalizedSpaceId,
      error: "Shutter capability issuance is not configured",
    };
  }

  let registry: CapabilityKeyRegistry;
  try {
    registry = parseCapabilityKeyRegistry(capabilityKeys);
  } catch {
    return {
      ok: false,
      kid,
      spaceId: normalizedSpaceId,
      error: "SHUTTER_CAPABILITY_KEYS is not a valid JSON key registry",
    };
  }

  const encoded = readCapabilityKeyMaterial(registry, normalizedSpaceId, kid);
  if (!encoded) {
    return {
      ok: false,
      kid,
      spaceId: normalizedSpaceId,
      error: `Shutter capability key ID "${kid}" is not active for space "${normalizedSpaceId}" (${formatRegistryHint(registry, normalizedSpaceId)})`,
    };
  }

  const key = decodeCapabilityKeyMaterial(encoded);
  if (key.byteLength !== 32) {
    return {
      ok: false,
      kid,
      spaceId: normalizedSpaceId,
      error: `Shutter capability key "${kid}" must decode to 32 bytes (got ${key.byteLength})`,
    };
  }

  return { ok: true, kid, spaceId: normalizedSpaceId };
}
