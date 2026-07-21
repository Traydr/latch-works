import type { SiteKey } from "../shared/sites";

export interface CompatibleFolderSegments {
  segments: string[];
  usedLegacyFolder: boolean;
}

export async function resolveCompatibleFolderSegments(
  rootDirectory: FileSystemDirectoryHandle,
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
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return { segments: standardSegments, usedLegacyFolder: false };
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "NotFoundError"
      : typeof error === "object" && error !== null && "name" in error && error.name === "NotFoundError"
  );
}
