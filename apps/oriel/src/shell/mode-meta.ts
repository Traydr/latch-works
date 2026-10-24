import { Images, type LucideIcon, RefreshCw, WandSparkles } from "lucide-react";

import { MODE_LABELS, type ModeId } from "../shared/shell";

interface ModeMeta {
  id: ModeId;
  label: string;
  icon: LucideIcon;
  shortcut: string;
}

/** The modes as the switcher shows them, in order (⌘1–3). */
export const MODE_META = [
  { id: "view", label: MODE_LABELS.view, icon: Images, shortcut: "⌘1" },
  { id: "tidy", label: MODE_LABELS.tidy, icon: WandSparkles, shortcut: "⌘2" },
  { id: "sync", label: MODE_LABELS.sync, icon: RefreshCw, shortcut: "⌘3" },
] as const satisfies readonly ModeMeta[];
