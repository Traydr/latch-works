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

function ActiveLayout(props: LayoutContentProps) {
  const { variant } = useLayoutVariant();

  switch (variant) {
    case 1:
      return <SidebarCommandLayout {...props} />;
    case 2:
      return <SplitWorkspaceLayout {...props} />;
    case 3:
      return <UnifiedDashboardLayout {...props} />;
    case 4:
      return <CompactToolbarLayout {...props} />;
    case 5:
      return <StatusBoardLayout {...props} />;
    default:
      return <SidebarCommandLayout {...props} />;
  }
}

export function LayoutRenderer(props: LayoutContentProps) {
  return (
    <div className="relative h-full min-h-0">
      <ActiveLayout {...props} />
      <LayoutSwitcher />
    </div>
  );
}
