import { z } from "zod";
import { parseJsonWith } from "@/lib/parse-json";
import { env } from "../../env/server";

/** The variables Shutter is configured from; the process environment by default. */
export type ShutterEnvironment = Pick<
  typeof env,
  | "SHUTTER_CAPABILITY_KEYS"
  | "SHUTTER_CAPABILITY_KID"
  | "SHUTTER_CONTROL_URL"
  | "SHUTTER_EDGE_URL"
  | "SHUTTER_RESOLVER_ID"
  | "SHUTTER_SPACE_API_TOKEN"
  | "SHUTTER_SPACE_ID"
>;

interface ShutterCapabilityKey {
  kid: string;
  key: Uint8Array<ArrayBuffer>;
}

/**
 * Shutter is all or nothing. Off, every variant is a signed bucket URL, video
 * and PDF tiles show a placeholder, and there is nothing to purge. On, it
 * delivers, renders previews, and is purged by maintenance.
 */
export type ShutterConfig =
  | { mode: "off" }
  | {
      capabilityKey: ShutterCapabilityKey;
      controlUrl: string;
      edgeUrl: string;
      mode: "on";
      /**
       * The Space's S3 resolver for the originals bucket. Set, images and
       * previews are v2 Delivery URLs and nothing is presigned per request;
       * unset, the v1 path seals a presigned locator into a Source Capability.
       */
      resolverId: string | null;
      spaceApiToken: string;
      spaceId: string;
    };

const REQUIRED_WHEN_ON = [
  "SHUTTER_CAPABILITY_KEYS",
  "SHUTTER_CAPABILITY_KID",
  "SHUTTER_CONTROL_URL",
  "SHUTTER_EDGE_URL",
  "SHUTTER_SPACE_API_TOKEN",
  "SHUTTER_SPACE_ID",
] as const satisfies readonly (keyof ShutterEnvironment)[];

const SHUTTER_VARIABLES = [
  ...REQUIRED_WHEN_ON,
  "SHUTTER_RESOLVER_ID",
] as const satisfies readonly (keyof ShutterEnvironment)[];

/**
 * Off when no SHUTTER_* variable is set; otherwise every one but the resolver
 * must be, and the capability key must be active for the Space. Throws naming
 * what is wrong, so a partial configuration stops the server at startup
 * instead of failing one request at a time.
 */
export function parseShutterConfig(environment: ShutterEnvironment): ShutterConfig {
  if (SHUTTER_VARIABLES.every((name) => environment[name] === "")) {
    return { mode: "off" };
  }

  const missing = REQUIRED_WHEN_ON.filter((name) => environment[name] === "");

  if (missing.length > 0) {
    throw new Error(
      `Shutter is partly configured: set ${missing.join(", ")}, or unset every SHUTTER_* variable to run without Shutter.`,
    );
  }

  const spaceId = unwrapEnvValue(environment.SHUTTER_SPACE_ID);

  return {
    capabilityKey: readCapabilityKey({
      capabilityKeys: environment.SHUTTER_CAPABILITY_KEYS,
      kid: unwrapEnvValue(environment.SHUTTER_CAPABILITY_KID),
      spaceId,
    }),
    controlUrl: environment.SHUTTER_CONTROL_URL,
    edgeUrl: environment.SHUTTER_EDGE_URL,
    mode: "on",
    resolverId: environment.SHUTTER_RESOLVER_ID || null,
    spaceApiToken: environment.SHUTTER_SPACE_API_TOKEN,
    spaceId,
  };
}

export const shutterConfig: ShutterConfig = parseShutterConfig(env);

/** Encoded key material: 64 hex characters or base64url. */
const KeyMaterialSchema = z.string();

/** One top-level registry entry: key material (flat layout) or a space's kid → material map. */
const RegistryEntrySchema = z.union([
  KeyMaterialSchema.transform((material) => ({ kind: "flat" as const, material })),
  z.record(z.string(), KeyMaterialSchema).transform((keys) => ({ kind: "space" as const, keys })),
]);

interface CapabilityKeyRegistry {
  flat: Record<string, string>;
  spaces: Record<string, Record<string, string>>;
}

/**
 * SHUTTER_CAPABILITY_KEYS: either flat (`{ kid: material }`) or nested per
 * space (`{ spaceId: { kid: material } }`); the two layouts may be mixed.
 */
const CapabilityKeyRegistrySchema = z
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

/** Strips one pair of surrounding quotes, which some hosts keep from a pasted value. */
function unwrapEnvValue(raw: string): string {
  const trimmed = raw.trim();

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function decodeCapabilityKeyMaterial(encoded: string): Uint8Array<ArrayBuffer> {
  const trimmed = encoded.trim();

  if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }

  return Uint8Array.from(Buffer.from(trimmed, "base64url"));
}

function formatRegistryHint(registry: CapabilityKeyRegistry, spaceId: string): string {
  const flatKids = Object.keys(registry.flat).sort();
  const nestedKids = Object.keys(registry.spaces[spaceId] ?? {}).sort();
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

function readCapabilityKey({
  capabilityKeys,
  kid,
  spaceId,
}: {
  capabilityKeys: string;
  kid: string;
  spaceId: string;
}): ShutterCapabilityKey {
  const registry = parseJsonWith(unwrapEnvValue(capabilityKeys), CapabilityKeyRegistryEnvSchema);

  if (registry === null) {
    throw new Error("SHUTTER_CAPABILITY_KEYS is not a valid JSON key registry");
  }

  const encoded = registry.spaces[spaceId]?.[kid] ?? registry.flat[kid];

  if (!encoded) {
    throw new Error(
      `Shutter capability key ID "${kid}" is not active for space "${spaceId}" (${formatRegistryHint(registry, spaceId)})`,
    );
  }

  const key = decodeCapabilityKeyMaterial(encoded);

  if (key.byteLength !== 32) {
    throw new Error(
      `Shutter capability key "${kid}" must decode to 32 bytes (got ${key.byteLength})`,
    );
  }

  return { key, kid };
}
