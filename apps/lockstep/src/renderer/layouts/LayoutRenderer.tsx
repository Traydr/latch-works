import { useLayoutVariant } from "./LayoutContext";
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
        <>
          <SidebarCommandLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
    case 2:
      return (
        <>
          <SplitWorkspaceLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
    case 3:
      return (
        <>
          <UnifiedDashboardLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
    case 4:
      return (
        <>
          <CompactToolbarLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
    case 5:
      return (
        <>
          <StatusBoardLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
    default:
      return (
        <>
          <SidebarCommandLayout {...layoutProps} />
          <LayoutSwitcher />
        </>
      );
  }
}
