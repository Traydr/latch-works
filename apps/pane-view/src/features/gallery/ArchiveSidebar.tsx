import { Archive, Folder } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

interface ArchiveSidebarProps {
  archiveRoot: string;
  currentPath: string;
  onNavigateToPath: (path: string) => void;
  roots: string[];
}

export function ArchiveSidebar({
  archiveRoot,
  currentPath,
  onNavigateToPath,
  roots,
}: ArchiveSidebarProps) {
  return (
    <Sidebar
      aria-label="Archive roots"
      className="hidden border-r border-sidebar-border md:flex"
      collapsible="none"
    >
      <SidebarHeader>
        <div className="flex items-center gap-3">
          <div
            className="grid size-9 place-items-center rounded-md border border-sidebar-border text-xs font-bold text-primary"
            aria-hidden="true"
          >
            LW
          </div>
          <div className="min-w-0">
            <strong className="block truncate text-sm font-semibold">Pane View</strong>
            <span className="block truncate text-xs text-muted-foreground">Latch Works</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Known archive paths">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={!currentPath}
                  onClick={() => onNavigateToPath("")}
                  title="Archive root"
                  tooltip="Archive root"
                >
                  <Archive className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{archiveRoot}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {roots.map((path) => (
                <SidebarMenuItem key={path}>
                  <SidebarMenuButton
                    isActive={path === currentPath}
                    onClick={() => onNavigateToPath(path)}
                    title={path}
                    tooltip={path}
                  >
                    <Folder className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
