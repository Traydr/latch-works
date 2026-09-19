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
  transform: async (blob, fileName) => ({ blob, fileName, converted: false })
};
