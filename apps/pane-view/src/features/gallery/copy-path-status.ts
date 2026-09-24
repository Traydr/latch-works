import { Check, CircleAlert, Copy, type LucideIcon } from "lucide-react";
import type { CopyStatus } from "@/hooks/use-copy-to-clipboard";

export const COPY_PATH_ICONS: Record<CopyStatus, LucideIcon> = {
  copied: Check,
  failed: CircleAlert,
  idle: Copy,
};

export const COPY_PATH_LABELS: Record<CopyStatus, string> = {
  copied: "Path copied",
  failed: "Copy failed",
  idle: "Copy path",
};
