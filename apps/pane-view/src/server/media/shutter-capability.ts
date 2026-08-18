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

export interface ShutterCapabilityKeyConfig {
  kid: string;
  key: Uint8Array<ArrayBuffer>;
}

/** The configuration a capability is issued from; the process environment by default. */
export type CapabilityEnvironment = Pick<
  typeof env,
  "SHUTTER_CAPABILITY_KEYS" | "SHUTTER_CAPABILITY_KID" | "SHUTTER_SPACE_ID"
>;

export function shutterCapabilityKeyConfig(
  environment: CapabilityEnvironment = env,
): ShutterCapabilityKeyConfig {
  const status = validateCapabilityKeyConfig({
    capabilityKeys: environment.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: environment.SHUTTER_CAPABILITY_KID,
    spaceId: environment.SHUTTER_SPACE_ID,
  });
  if (!status.ok) throw new Error(status.error);

  const registry = parseCapabilityKeyRegistry(environment.SHUTTER_CAPABILITY_KEYS);
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
  environment: CapabilityEnvironment = env,
): Promise<string> {
  const options = shutterCapabilityKeyConfig(environment);
  return ivOverride === undefined
    ? issueSourceCapability(claims, options)
    : issueSourceCapabilityWithIv(claims, options, ivOverride);
}

export interface CapabilityClaimTimes {
  iat: number;
  exp: number;
}

export function shutterCapabilityClaimTimes(): CapabilityClaimTimes {
  const iat = Math.floor(Date.now() / 1000);
  return { iat, exp: iat + CAPABILITY_LIFETIME_SECONDS };
}
