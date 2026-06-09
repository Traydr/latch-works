import type { FolderNode } from "@latch-works/media-domain";
import { Archive, ChevronRight, Folder, LogOut, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface ArchiveSidebarProps {
  currentPath: string;
  folders: FolderNode[];
  isLoading?: boolean;
  onNavigateToPath: (path: string) => void;
  onOpenSettings: () => void;
}

export function ArchiveSidebar({
  currentPath,
  folders,
  isLoading = false,
  onNavigateToPath,
  onOpenSettings,
}: ArchiveSidebarProps) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const ancestors = buildAncestorItems(currentPath);
  const childFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Sidebar
      aria-label="Archive folders"
      className="border-r border-sidebar-border"
      collapsible="icon"
    >
      <SidebarHeader>
        <div className="flex items-center gap-3 overflow-hidden px-2 py-1.5">
          <div
            className="grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border text-[10px] font-bold text-primary"
            aria-hidden="true"
          >
            LW
          </div>
          <div className={cn("min-w-0 transition-opacity", isCollapsed && "opacity-0")}>
            <strong className="block truncate text-sm font-semibold">Pane View</strong>
            <span className="block truncate text-[11px] text-muted-foreground">Latch Works</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className={cn("overflow-y-auto", isLoading && "opacity-70")}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Archive folders">
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="rounded-none min-h-10 md:min-h-8 hover:bg-sidebar-accent"
                  isActive={!currentPath}
                  onClick={() => onNavigateToPath("")}
                  title="Archive root"
                  tooltip="Archive root"
                >
                  <Archive className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Archive root</span>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {ancestors.map((ancestor) => {
                const depth = ancestor.path.split("/").filter(Boolean).length;

                return (
                  <SidebarMenuItem key={ancestor.path}>
                    <SidebarMenuButton
                      className={cn(
                        "rounded-none",
                        isCollapsed ? "" : "justify-start gap-1.5 px-2",
                      )}
                      isActive={ancestor.path === currentPath}
                      onClick={() => onNavigateToPath(ancestor.path)}
                      title={ancestor.path}
                      tooltip={ancestor.path}
                      style={isCollapsed ? undefined : { paddingLeft: `${12 + depth * 12}px` }}
                    >
                      <Folder className="size-3.5 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 truncate text-xs">{ancestor.name}</span>
                      {ancestor.path !== currentPath && !isCollapsed ? (
                        <ChevronRight className="size-3 shrink-0 opacity-60" />
                      ) : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}

              {childFolders.map((folder) => {
                const depth = folder.path.split("/").filter(Boolean).length;

                return (
                  <SidebarMenuItem key={folder.path}>
                    <SidebarMenuButton
                      className={cn(
                        "rounded-none",
                        isCollapsed ? "" : "justify-start gap-1.5 px-2",
                      )}
                      onClick={() => onNavigateToPath(folder.path)}
                      title={folder.path}
                      tooltip={folder.path}
                      style={isCollapsed ? undefined : { paddingLeft: `${12 + depth * 12}px` }}
                    >
                      <Folder className="size-3.5 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1 truncate text-xs">{folder.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <div className="grid gap-1">
          <Button
            className="w-full justify-start gap-2"
            onClick={onOpenSettings}
            type="button"
            variant="ghost"
          >
            <Settings className="size-4" />
            <span>Settings</span>
          </Button>
          <form action="/api/auth/logout" method="post">
            <Button className="w-full justify-start gap-2" type="submit" variant="ghost">
              <LogOut className="size-4" />
              <span>Sign out</span>
            </Button>
          </form>
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function buildAncestorItems(
  currentPath: string,
): Array<{ name: string; path: string }> {
  if (!currentPath) {
    return [];
  }

  const segments = currentPath.split("/").filter(Boolean);
  return segments.map((segment, index) => {
    const path = segments.slice(0, index + 1).join("/");
    return {
      name: segment,
      path,
    };
  });
}
