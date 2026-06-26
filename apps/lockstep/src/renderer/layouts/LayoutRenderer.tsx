import { useLayoutVariant } from "./LayoutContext";
import { LayoutShell } from "./LayoutShell";
import { LayoutSwitcher } from "./LayoutSwitcher";
import type { LayoutContentProps } from "./types";
import {
  CompactToolbarLayout,
  SidebarCommandLayout,
  SplitWorkspaceLayout,
  StatusBoardLayout,
  UnifiedDashboardLayout,
} from "./variants";

export function LayoutRenderer(props: LayoutContentProps) {
  const { variant } = useLayoutVariant();

  const layoutProps = { ...props };

  switch (variant) {
    case 1:
      return (
        <LayoutShell>
          <SidebarCommandLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
    case 2:
      return (
        <LayoutShell>
          <SplitWorkspaceLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
    case 3:
      return (
        <LayoutShell>
          <UnifiedDashboardLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
    case 4:
      return (
        <LayoutShell>
          <CompactToolbarLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
    case 5:
      return (
        <LayoutShell>
          <StatusBoardLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
    default:
      return (
        <LayoutShell>
          <SidebarCommandLayout {...layoutProps} />
          <LayoutSwitcher />
        </LayoutShell>
      );
  }
}
