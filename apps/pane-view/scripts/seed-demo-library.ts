import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createS3StorageClient,
  originalObjectKey,
  putStoredObject,
  readS3StorageConfig,
} from "@latch-works/media-storage";
import { eq } from "drizzle-orm";
import { db } from "../src/server/db";
import { folders, libraryEntries, mediaObjects } from "../src/server/db/schema";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sampleImagePath = resolve(scriptDir, "demo-assets/sample.jpg");

async function main(): Promise<void> {
  const bytes = readFileSync(sampleImagePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = "jpg";
  const objectKey = originalObjectKey({ extension, mediaType: "image", sha256 });
  const mediaObjectId = randomUUID();
  const entryId = randomUUID();

  const storageConfig = readS3StorageConfig(process.env);
  if (!storageConfig) {
    throw new Error("S3 storage is not configured");
  }
  const storage = createS3StorageClient(storageConfig);

  await putStoredObject({
    body: bytes,
    contentType: "image/jpeg",
    key: objectKey,
    storage,
  });

  await db
    .insert(folders)
    .values({
      entryCount: 1,
      folderCount: 0,
      name: "photos",
      parentPath: "",
      path: "photos",
    })
    .onConflictDoNothing();

  await db
    .insert(mediaObjects)
    .values({
      contentType: "image/jpeg",
      extension,
      height: 800,
      id: mediaObjectId,
      mediaType: "image",
      objectKey,
      sha256,
      size: bytes.byteLength,
      width: 1200,
    })
    .onConflictDoNothing();

  await db
    .insert(libraryEntries)
    .values({
      filename: "sample.jpg",
      id: entryId,
      logicalPath: "photos/sample.jpg",
      mediaObjectId,
      mtimeMs: Date.now(),
      parentPath: "photos",
      sha256,
      size: bytes.byteLength,
    })
    .onConflictDoNothing();

  const [entry] = await db
    .select({ id: libraryEntries.id, logicalPath: libraryEntries.logicalPath })
    .from(libraryEntries)
    .where(eq(libraryEntries.logicalPath, "photos/sample.jpg"))
    .limit(1);

  console.log(
    JSON.stringify({
      entryId: entry?.id ?? entryId,
      logicalPath: entry?.logicalPath ?? "photos/sample.jpg",
      objectKey,
      sha256,
    }),
  );
}

void main();
