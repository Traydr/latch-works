import { toError } from "./errors";
import type { SiteKey } from "../shared/sites";

/** The archive root, narrowed to the lookup this compatibility probe performs. */
export interface LegacyFolderLookup {
  getDirectoryHandle(name: string): Promise<{ name: string }>;
}

export interface CompatibleFolderSegments {
  segments: string[];
  usedLegacyFolder: boolean;
}

export async function resolveCompatibleFolderSegments(
  rootDirectory: LegacyFolderLookup,
  site: SiteKey,
  standardSegments: string[]
): Promise<CompatibleFolderSegments> {
  if (site !== "hentaifoundry-pictures" || standardSegments.length !== 1) {
    return { segments: standardSegments, usedLegacyFolder: false };
  }

  const standardArtist = standardSegments[0];
  const legacyArtist = standardArtist.toLowerCase();
  if (legacyArtist === standardArtist) {
    return { segments: standardSegments, usedLegacyFolder: false };
  }

  try {
    const legacyDirectory = await rootDirectory.getDirectoryHandle(legacyArtist);
    if (legacyDirectory.name === legacyArtist) {
      return { segments: [legacyArtist], usedLegacyFolder: true };
    }
  } catch (error) {
    if (!isNotFoundError(toError(error))) {
      throw error;
    }
  }

  return { segments: standardSegments, usedLegacyFolder: false };
}

function isNotFoundError(error: Error): boolean {
  return error.name === "NotFoundError";
}
