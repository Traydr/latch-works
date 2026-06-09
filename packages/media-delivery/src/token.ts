import { createHmac, timingSafeEqual } from "node:crypto";

export type DeliveryPurpose = "thumbnail" | "preview";

export interface DeliveryTokenPayload {
  exp: number;
  objectKey: string;
  purpose: DeliveryPurpose;
}

export interface DeliveryTokenSigner {
  sign(payload: DeliveryTokenPayload): string;
  verify(token: string): DeliveryTokenPayload | null;
}

const TOKEN_SEPARATOR = "~";

export function createDeliveryTokenSigner(secret: string): DeliveryTokenSigner {
  return {
    sign(payload) {
      const encodedPayload = encodePayload(payload);
      const signature = signPayload(encodedPayload, secret);
      return `${encodedPayload}${TOKEN_SEPARATOR}${signature}`;
    },
    verify(token) {
      const separatorIndex = token.lastIndexOf(TOKEN_SEPARATOR);
      if (separatorIndex <= 0) {
        return null;
      }

      const encodedPayload = token.slice(0, separatorIndex);
      const signature = token.slice(separatorIndex + TOKEN_SEPARATOR.length);
      if (!encodedPayload || !signature) {
        return null;
      }

      const expectedSignature = signPayload(encodedPayload, secret);
      const provided = Buffer.from(signature, "base64url");
      const expected = Buffer.from(expectedSignature, "base64url");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return null;
      }

      let payload: DeliveryTokenPayload;
      try {
        payload = decodePayload(encodedPayload);
      } catch {
        return null;
      }

      if (payload.exp * 1000 <= Date.now()) {
        return null;
      }

      if (!payload.objectKey || !payload.purpose) {
        return null;
      }

      return payload;
    },
  };
}

export function buildCdnDeliveryPath(token: string): string {
  return `/cdn/v1/${token}`;
}

export function readDeliveryTokenExpiration(nowSeconds: number, ttlSeconds: number): number {
  return (Math.floor(nowSeconds / ttlSeconds) + 1) * ttlSeconds;
}

function encodePayload(payload: DeliveryTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encodedPayload: string): DeliveryTokenPayload {
  const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as DeliveryTokenPayload;
  if (
    typeof parsed.exp !== "number" ||
    typeof parsed.objectKey !== "string" ||
    (parsed.purpose !== "thumbnail" && parsed.purpose !== "preview")
  ) {
    throw new Error("Invalid delivery token payload");
  }

  return parsed;
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}
