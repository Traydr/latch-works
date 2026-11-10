import { numberFileNames } from "../path";
import type { GatherSourcePolicy } from "../source-policies";

/**
 * With the "post folders" setting on, a multi-image post moves into a folder named after its ID
 * and its files are numbered in post order. Single-image posts stay in the user folder.
 */
export const X_POLICY: GatherSourcePolicy = {
  prepareOutput: (payload, settings) =>
    settings.xPostFolders && payload.galleryId && payload.images.length > 1
      ? {
          ...payload,
          folderSegments: [...payload.folderSegments, payload.galleryId],
          images: numberFileNames(payload.images),
        }
      : payload,
  describeSave: (save, settings) =>
    settings.xPostFolders
      ? {
          pathTemplate: `${save.pathTemplate}[<post id>/]`,
          fileNote: "Multi-image posts get a folder and number their files 01_, 02_, …",
        }
      : save,
};
