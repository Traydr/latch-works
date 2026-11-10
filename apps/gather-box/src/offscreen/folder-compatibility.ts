import { toError } from "../shared/errors";
import type { SiteKey } from "../shared/source-catalog";
import { getSourcePolicy } from "../shared/source-policies";

export interface LegacyFolderLookup {
  getDirectoryHandle(name: string): Promise<{ name: string }>;
}

export interface CompatibleFolderSegments {
  segments: string[];
  usedLegacyFolder: boolean;
}

/** The source's legacy folder when one already exists in the archive, its standard one otherwise. */
export async function resolveCompatibleFolderSegments(
  rootDirectory: LegacyFolderLookup,
  site: SiteKey,
  standardSegments: string[],
): Promise<CompatibleFolderSegments> {
  const [folder, ...nested] = standardSegments;

  const legacy =
    folder !== undefined && nested.length === 0
      ? getSourcePolicy(site).legacyFolderName?.(folder)
      : null;

  if (!legacy) {
    return { segments: standardSegments, usedLegacyFolder: false };
  }

  try {
    const legacyDirectory = await rootDirectory.getDirectoryHandle(legacy);

    // A case-insensitive file system finds the standard folder under the legacy name too.
    if (legacyDirectory.name === legacy) {
      return { segments: [legacy], usedLegacyFolder: true };
    }
  } catch (error) {
    if (toError(error).name !== "NotFoundError") {
      throw error;
    }
  }

  return { segments: standardSegments, usedLegacyFolder: false };
}
