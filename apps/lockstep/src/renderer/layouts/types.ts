import type { ReactNode } from "react";

import type { DoctorResult, LockstepPlan, LockstepPlanItem, LockstepProfilePublic, LockstepSettings } from "../../shared/types";
import type { RunProgressState } from "../utils/runProgress";

export type LayoutVariant = 1 | 2 | 3 | 4 | 5;

export type Screen = "dashboard" | "plan" | "profile" | "run";

export interface LayoutActionHandlers {
  onBack: () => void;
  onCancel: () => void;
  onCreateProfile: () => void;
  onDoctor: () => void;
  onFilterChange: (value: string) => void;
  onPlan: () => void;
  onPrune: () => void;
  onProfileChange: (profileId: string) => void;
  onPush: () => void;
  onSessionTokenChange: (value: string) => void;
  onViewActivity: () => void;
  onViewPlan: () => void;
}

export interface LayoutContentProps {
  activeProfile: LockstepProfilePublic | null;
  doctorResult: DoctorResult | null;
  error: string | null;
  filter: string;
  filteredItems: LockstepPlanItem[];
  handlers: LayoutActionHandlers;
  logs: string[];
  plan: LockstepPlan | null;
  profileForm: {
    apiUrl: string;
    name: string;
    sourceRoot: string;
    token: string;
  };
  runLabel: string;
  runProgress: RunProgressState;
  running: boolean;
  screen: Screen;
  sessionToken: string;
  settings: LockstepSettings | null;
  onCancelProfile: () => void;
  onPickFolder: () => void;
  onProfileFormChange: (patch: Partial<LayoutContentProps["profileForm"]>) => void;
  onSubmitProfile: (event: React.FormEvent) => void;
}

export interface LayoutProps extends LayoutContentProps {
  children?: ReactNode;
}

export const layoutLabels: Record<LayoutVariant, string> = {
  1: "Sidebar Command",
  2: "Split Workspace",
  3: "Unified Dashboard",
  4: "Compact Toolbar",
  5: "Status Board",
};
