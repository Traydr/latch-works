import { env } from "../../env/server";
import {
  decodeCapabilityKeyMaterial,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";

const CAPABILITY_LIFETIME_SECONDS = 24 * 60 * 60;

type CapabilityPurpose = "image_source" | "master_preview" | "preview_job";
type PreviewKind = "video" | "pdf";
type CommonClaims = {
  space_id: string;
  source_id: string;
  purpose: CapabilityPurpose;
  iat: number;
  exp: number;
};

export type CapabilityClaims =
  | (CommonClaims & { purpose: "image_source"; locator: string })
  | (CommonClaims & { purpose: "master_preview"; kind: PreviewKind })
  | (CommonClaims & { purpose: "preview_job"; kind: PreviewKind; locator: string });

function frameStrings(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const output = new Uint8Array(encoded.reduce((sum, value) => sum + value.byteLength + 4, 0));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of encoded) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function capabilityKey(): { kid: string; key: Uint8Array<ArrayBuffer> } {
  const status = validateCapabilityKeyConfig({
    capabilityKeys: env.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: env.SHUTTER_CAPABILITY_KID,
    spaceId: env.SHUTTER_SPACE_ID,
  });
  if (!status.ok) throw new Error(status.error);

  const registry = parseCapabilityKeyRegistry(env.SHUTTER_CAPABILITY_KEYS);
  const encoded = readCapabilityKeyMaterial(registry, status.spaceId, status.kid);
  if (!encoded) {
    throw new Error(
      `Shutter capability key ID "${status.kid}" is not active for space "${status.spaceId}"`,
    );
  }

  return { kid: status.kid, key: decodeCapabilityKeyMaterial(encoded) };
}

function canonicalClaims(claims: CapabilityClaims): string {
  const common = {
    space_id: claims.space_id,
    source_id: claims.source_id,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (claims.purpose === "image_source")
    return JSON.stringify({ ...common, locator: claims.locator });
  if (claims.purpose === "master_preview") return JSON.stringify({ ...common, kind: claims.kind });
  return JSON.stringify({ ...common, kind: claims.kind, locator: claims.locator });
}

export async function issueShutterCapability(
  claims: CapabilityClaims,
  ivOverride?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const { kid, key } = capabilityKey();
  const iv = ivOverride ?? crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: frameStrings(["v1", claims.space_id, kid, claims.purpose]),
      tagLength: 128,
    },
    cryptoKey,
    new TextEncoder().encode(canonicalClaims(claims)),
  );
  return `v1.${kid}.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

export function shutterCapabilityClaimTimes(): { iat: number; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  return { iat, exp: iat + CAPABILITY_LIFETIME_SECONDS };
}
