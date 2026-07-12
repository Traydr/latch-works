export type CapabilityKeyRegistry = Record<string, unknown>;

export type CapabilityKeyConfigStatus =
  | { ok: true; kid: string; spaceId: string }
  | { ok: false; kid: string; spaceId: string; error: string };

function isKeyMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assertCapabilityKeyRegistry(value: unknown): CapabilityKeyRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyntaxError("Invalid capability key registry");
  }
  return value as CapabilityKeyRegistry;
}

export function parseCapabilityKeyRegistry(raw: string): CapabilityKeyRegistry {
  let parsed: unknown = JSON.parse(unwrapEnvJson(raw));
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed);
  }
  return assertCapabilityKeyRegistry(parsed);
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
): { flatKids: string[]; nestedKids: string[] } {
  const nestedKids: string[] = [];
  const flatKids: string[] = [];

  for (const [key, value] of Object.entries(registry)) {
    if (typeof value === "string") {
      flatKids.push(key);
      continue;
    }
    if (key === spaceId && isKeyMap(value)) {
      nestedKids.push(...Object.keys(value).filter((kid) => typeof value[kid] === "string"));
    }
  }

  return {
    flatKids: flatKids.sort(),
    nestedKids: nestedKids.sort(),
  };
}

export function readCapabilityKeyMaterial(
  registry: CapabilityKeyRegistry,
  spaceId: string,
  kid: string,
): string | undefined {
  const spaceKeys = registry[spaceId];
  if (isKeyMap(spaceKeys)) {
    const encoded = spaceKeys[kid];
    if (typeof encoded === "string") {
      return encoded;
    }
  }

  const flat = registry[kid];
  return typeof flat === "string" ? flat : undefined;
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
      error: "SHUTTER_CAPABILITY_KEYS is not valid JSON",
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
