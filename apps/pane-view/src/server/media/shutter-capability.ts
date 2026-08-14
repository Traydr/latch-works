import { issueSourceCapability, type SourceCapabilityClaims } from "@shutter/protocol";
import { issueSourceCapabilityWithIv } from "@shutter/protocol/testing";
import { env } from "../../env/server";
import {
  decodeCapabilityKeyMaterial,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";

const CAPABILITY_LIFETIME_SECONDS = 24 * 60 * 60;

export type CapabilityClaims = Exclude<SourceCapabilityClaims, { purpose: "source_delivery" }>;

export function shutterCapabilityKeyConfig(): { kid: string; key: Uint8Array<ArrayBuffer> } {
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

export async function issueShutterCapability(
  claims: CapabilityClaims,
  ivOverride?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const options = shutterCapabilityKeyConfig();
  return ivOverride === undefined
    ? issueSourceCapability(claims, options)
    : issueSourceCapabilityWithIv(claims, options, ivOverride);
}

export function shutterCapabilityClaimTimes(): { iat: number; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  return { iat, exp: iat + CAPABILITY_LIFETIME_SECONDS };
}
