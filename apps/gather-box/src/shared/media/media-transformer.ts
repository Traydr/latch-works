import type { GatherBoxSettings } from "../settings";

export interface TransformedMedia {
  blob: Blob;
  fileName: string;
  converted: boolean;
  /** Why the original was kept although the archive wanted it converted. */
  conversionFailure?: string;
}

export interface MediaTransformer {
  expectedTarget(fileName: string): string | null;
  transform(blob: Blob, fileName: string, signal?: AbortSignal): Promise<TransformedMedia>;
}

export const IDENTITY_MEDIA_TRANSFORMER: MediaTransformer = {
  expectedTarget: () => null,
  transform: async (blob, fileName) => ({ blob, fileName, converted: false }),
};

/** What archived items become under these settings. The converters load only when asked for. */
export async function loadMediaTransformer(settings: GatherBoxSettings): Promise<MediaTransformer> {
  if (!settings.mediaCompatibilityMode) {
    return IDENTITY_MEDIA_TRANSFORMER;
  }

  const { ARCHIVE_MEDIA_TRANSFORMER } = await import("./archive-media-transformer");

  return ARCHIVE_MEDIA_TRANSFORMER;
}
