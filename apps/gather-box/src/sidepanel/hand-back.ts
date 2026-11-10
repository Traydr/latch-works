import {
  getOrCreateNestedDirectory,
  type NestableDirectory,
  type SavedArchiveItem,
  saveArchiveItem,
} from "../shared/archive-writer";
import type { HandBackItem } from "../shared/gather-queue";
import { loadMediaTransformer } from "../shared/media/media-transformer";
import { sanitizeFileName, sanitizeFolderSegments } from "../shared/path";
import type { GatherBoxSettings } from "../shared/settings";

export interface HandBackSave {
  item: HandBackItem;
  /** The file you downloaded yourself after the site check blocked Gather Box. */
  file: File;
  /** The remembered folder of the run's source, in the profile chosen now. */
  rootDirectory: NestableDirectory;
  /** The settings now, which decide what the file becomes, as they do for a retry. */
  settings: GatherBoxSettings;
}

/**
 * Saves a file you downloaded yourself where the blocked download would have gone, as the item a
 * gather would have saved. A different file already there is never overwritten, and the same file
 * is recognised and left as it is.
 */
export async function saveHandedBackFile(save: HandBackSave): Promise<SavedArchiveItem> {
  const { item, file, rootDirectory, settings } = save;
  const fileName = sanitizeFileName(item.fileName);

  if (!fileName) {
    throw new Error(`"${item.fileName}" has no usable file name.`);
  }

  const expectedExtension = getExtension(fileName);

  if (expectedExtension && getExtension(file.name) !== expectedExtension) {
    throw new Error(`Choose the ${expectedExtension} file you downloaded, not ${file.name}.`);
  }

  const directory = await getOrCreateNestedDirectory(
    rootDirectory,
    sanitizeFolderSegments(item.folderSegments),
  );

  return saveArchiveItem(
    { blob: file, contentType: file.type, fileName },
    directory,
    await loadMediaTransformer(settings),
  );
}

/** The lowercased extension with its dot, such as `.pdf`, or an empty string when there is none. */
export function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");

  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}
