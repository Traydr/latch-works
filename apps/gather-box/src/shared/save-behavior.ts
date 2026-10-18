import type { GatherBoxSettings } from "./settings";
import { getGatherSource, type SiteKey, type SourceSaveBehavior } from "./source-catalog";

export type SaveBehavior = SourceSaveBehavior;

export function getSaveBehavior(
  siteKey: SiteKey | null,
  settings: Pick<GatherBoxSettings, "xPostFolders">
): SaveBehavior | null {
  const behavior = siteKey ? getGatherSource(siteKey)?.save : undefined;

  if (!behavior) {
    return null;
  }

  // Mirrors groupXPostInFolder, which only applies with this setting on.
  if (siteKey === "x" && settings.xPostFolders) {
    return {
      pathTemplate: `${behavior.pathTemplate}[<post id>/]`,
      fileNote: "Multi-image posts get a folder and number their files 01_, 02_, …"
    };
  }

  return behavior;
}
