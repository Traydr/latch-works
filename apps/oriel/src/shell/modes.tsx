import type { ComponentType } from "react";

import { SyncMode } from "../modes/sync/renderer/App";
import { TidyMode } from "../modes/tidy/renderer/App";
import { ViewMode } from "../modes/view/renderer/App";
import type { ModeId } from "../shared/shell";

/** Each mode's whole window, inside a `ModeLayout`. */
export const MODE_ROOTS = {
  view: ViewMode,
  tidy: TidyMode,
  sync: SyncMode,
} satisfies Record<ModeId, ComponentType>;
