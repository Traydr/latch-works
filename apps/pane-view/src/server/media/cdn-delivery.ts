import {
  buildCdnDeliveryPath,
  createDeliveryTokenSigner,
  type DeliveryPurpose,
  readDeliveryTokenExpiration,
} from "@latch-works/media-delivery";
import { env } from "../../env/server";

const deliverySigner = createDeliveryTokenSigner(env.MEDIA_DELIVERY_SECRET);

function mintDeliveryToken({
  objectKey,
  purpose,
}: {
  objectKey: string;
  purpose: DeliveryPurpose;
}): string {
  return deliverySigner.sign({
    exp: readDeliveryTokenExpiration(Math.floor(Date.now() / 1000), env.MEDIA_DELIVERY_TTL_SECONDS),
    objectKey,
    purpose,
  });
}

export function buildSignedCdnDeliveryUrl({
  objectKey,
  purpose,
}: {
  objectKey: string;
  purpose: DeliveryPurpose;
}): string {
  return buildCdnDeliveryPath(mintDeliveryToken({ objectKey, purpose }));
}

export function mintOriginalDeliveryToken(objectKey: string): string {
  return mintDeliveryToken({ objectKey, purpose: "original" });
}

export function verifyCdnDeliveryToken(token: string) {
  return deliverySigner.verify(token);
}

export function buildCdnCacheControl(ttlSeconds: number): string {
  return `public, max-age=${ttlSeconds}`;
}

export function readCdnCacheControl(): string {
  return buildCdnCacheControl(env.MEDIA_DELIVERY_TTL_SECONDS);
}

export const API_PRIVATE_CACHE_CONTROL = "private, no-store";

export function readDeliveryPurposeForObjectKey(objectKey: string): DeliveryPurpose {
  return objectKey.startsWith("previews/") ? "preview" : "thumbnail";
}
