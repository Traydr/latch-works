import type { GatherSourcePolicy } from "../source-policies";

/** Older builds lowercased the whole artist name; an existing folder of that name is reused. */
export const HENTAI_FOUNDRY_PICTURES_POLICY: GatherSourcePolicy = {
  legacyFolderName: (folder) => {
    const legacy = folder.toLowerCase();

    return legacy === folder ? null : legacy;
  },
};
