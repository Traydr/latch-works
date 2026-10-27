import type { HandBackItem } from "../shared/gather-queue";
import { sanitizeFileName, sanitizePathSegment } from "../shared/path";
import {
  assertSavableFile,
  getOrCreateNestedDirectory,
  saveBlobWithoutClobbering,
  type CollisionSaveResult,
  type NestableDirectory
} from "./downloader";

export interface HandBackSave {
  item: HandBackItem;
  /** The file you downloaded yourself after the site check blocked Gather Box. */
  file: File;
  /** The remembered folder of the run's source, in the profile chosen now. */
  rootDirectory: NestableDirectory;
}

/**
 * Saves a file you downloaded yourself where the blocked download would have gone, under the name
 * it would have had. A different file already there is never overwritten, and the same file is
 * recognised and left as it is.
 */
export async function saveHandedBackFile(save: HandBackSave): Promise<CollisionSaveResult> {
  const { item, file, rootDirectory } = save;
  const fileName = sanitizeFileName(item.fileName);

  if (!fileName) {
    throw new Error(`"${item.fileName}" has no usable file name.`);
  }

  const expectedExtension = getExtension(fileName);

  if (expectedExtension && getExtension(file.name) !== expectedExtension) {
    throw new Error(`Choose the ${expectedExtension} file you downloaded, not ${file.name}.`);
  }

  await assertSavableFile({ blob: file, contentType: file.type, fileName });

  const segments = item.folderSegments.flatMap((segment) => {
    const sanitized = sanitizePathSegment(segment);

    return sanitized ? [sanitized] : [];
  });

  const directory = await getOrCreateNestedDirectory(rootDirectory, segments);

  return saveBlobWithoutClobbering(file, directory, fileName);
}

/** The lowercased extension with its dot, such as `.pdf`, or an empty string when there is none. */
export function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");

  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}
