import { env } from "../../env/server";
import {
  decodeCapabilityKeyMaterial,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";

export interface ShutterCapabilityKeyConfig {
  kid: string;
  key: Uint8Array<ArrayBuffer>;
}

/** The configuration a capability is issued from; the process environment by default. */
export type CapabilityEnvironment = Pick<
  typeof env,
  "SHUTTER_CAPABILITY_KEYS" | "SHUTTER_CAPABILITY_KID" | "SHUTTER_SPACE_ID"
>;

/** The last key config read, with the environment strings it was read from. */
let cachedKeyConfig:
  | { config: ShutterCapabilityKeyConfig; environment: CapabilityEnvironment }
  | undefined;

/**
 * Every Shutter URL needs the key config, so it is read once per distinct
 * environment rather than parsing and validating the registry on each call.
 * Keyed by the strings, not the object, so a changed environment is re-read.
 */
export function shutterCapabilityKeyConfig(
  environment: CapabilityEnvironment = env,
): ShutterCapabilityKeyConfig {
  const cached = cachedKeyConfig;

  if (
    cached?.environment.SHUTTER_CAPABILITY_KEYS === environment.SHUTTER_CAPABILITY_KEYS &&
    cached.environment.SHUTTER_CAPABILITY_KID === environment.SHUTTER_CAPABILITY_KID &&
    cached.environment.SHUTTER_SPACE_ID === environment.SHUTTER_SPACE_ID
  ) {
    return cached.config;
  }

  const config = readShutterCapabilityKeyConfig(environment);

  cachedKeyConfig = {
    config,
    environment: {
      SHUTTER_CAPABILITY_KEYS: environment.SHUTTER_CAPABILITY_KEYS,
      SHUTTER_CAPABILITY_KID: environment.SHUTTER_CAPABILITY_KID,
      SHUTTER_SPACE_ID: environment.SHUTTER_SPACE_ID,
    },
  };

  return config;
}

function readShutterCapabilityKeyConfig(
  environment: CapabilityEnvironment,
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
