import { Archive, ChevronUp, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import { type FormEvent, Fragment, type JSX, useMemo } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { buildBreadcrumbItems, getParentPath } from "@/features/gallery/browse-search";

type Breadcrumbs = ReturnType<typeof buildBreadcrumbItems>;

export interface GalleryHeaderProps {
  /** The archive root's label. */
  archiveRoot: string;
  canNavigateSiblings: boolean;
  displayPath: string;
  isMobile: boolean;
  onDetailPanelOpenChange: (open: boolean) => void;
  onNavigateSiblingFolder: (offset: -1 | 1) => void;
  onNavigateToPath: (path: string) => void;
  onOpenMobileSearch: () => void;
  onPathSheetOpenChange: (open: boolean) => void;
  onSearchDraftChange: (draft: string) => void;
  onSubmitSearch: (event: FormEvent<HTMLFormElement>) => void;
  pathSheetOpen: boolean;
  searchDraft: string;
  showDetailPanel: boolean;
}

/** The page's top bar: the folder path, search, and the preview-panel toggle. */
export function GalleryHeader({
  archiveRoot,
  canNavigateSiblings,
  displayPath,
  isMobile,
  onDetailPanelOpenChange,
  onNavigateSiblingFolder,
  onNavigateToPath,
  onOpenMobileSearch,
  onPathSheetOpenChange,
  onSearchDraftChange,
  onSubmitSearch,
  pathSheetOpen,
  searchDraft,
  showDetailPanel,
}: GalleryHeaderProps): JSX.Element {
  const breadcrumbs = useMemo(() => buildBreadcrumbItems(displayPath), [displayPath]);

  return (
    <>
      <header className="flex h-auto min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SidebarTrigger className="-ml-1 shrink-0" />
          {isMobile ? (
            <MobilePathHeader
              currentFolderName={breadcrumbs[breadcrumbs.length - 1]?.label ?? archiveRoot}
              displayPath={displayPath}
              onNavigateToPath={onNavigateToPath}
              onOpenPathSheet={() => onPathSheetOpenChange(true)}
            />
          ) : (
            <DesktopPathHeader
              archiveRoot={archiveRoot}
              breadcrumbs={breadcrumbs}
              canNavigateSiblings={canNavigateSiblings}
              displayPath={displayPath}
              onNavigateSiblingFolder={onNavigateSiblingFolder}
              onNavigateToPath={onNavigateToPath}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            className="md:hidden"
            onClick={onOpenMobileSearch}
            size="icon"
            type="button"
            variant="outline"
          >
            <Search className="size-4" />
          </Button>
          <form className="relative hidden w-72 items-center md:flex" onSubmit={onSubmitSearch}>
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search archive"
              className="pl-8"
              onChange={(event) => onSearchDraftChange(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
          </form>
          <Button
            aria-expanded={showDetailPanel}
            aria-label={showDetailPanel ? "Hide preview panel" : "Show preview panel"}
            className="hidden shrink-0 lg:inline-flex"
            onClick={() => onDetailPanelOpenChange(!showDetailPanel)}
            size="icon"
            title={showDetailPanel ? "Hide preview panel" : "Show preview panel"}
            type="button"
            variant="outline"
          >
            {showDetailPanel ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </Button>
        </div>
      </header>
      <PathSheet
        archiveRoot={archiveRoot}
        breadcrumbs={breadcrumbs}
        onNavigateToPath={onNavigateToPath}
        onOpenChange={onPathSheetOpenChange}
        open={pathSheetOpen}
      />
    </>
  );
}

function MobilePathHeader({
  currentFolderName,
  displayPath,
  onNavigateToPath,
  onOpenPathSheet,
}: {
  currentFolderName: string;
  displayPath: string;
  onNavigateToPath: (path: string) => void;
  onOpenPathSheet: () => void;
}): JSX.Element {
  const parentPath = getParentPath(displayPath);

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <Button
          disabled={!parentPath && displayPath === ""}
          onClick={() => onNavigateToPath(parentPath ?? "")}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronUp className="size-4" />
        </Button>
        <button
          className="min-w-0 flex-1 truncate text-left text-base font-semibold"
          onClick={onOpenPathSheet}
          type="button"
        >
          {currentFolderName}
        </button>
      </div>
      {displayPath ? <p className="truncate text-xs text-muted-foreground">{displayPath}</p> : null}
    </div>
  );
}

function DesktopPathHeader({
  archiveRoot,
  breadcrumbs,
  canNavigateSiblings,
  displayPath,
  onNavigateSiblingFolder,
  onNavigateToPath,
}: {
  archiveRoot: string;
  breadcrumbs: Breadcrumbs;
  canNavigateSiblings: boolean;
  displayPath: string;
  onNavigateSiblingFolder: (offset: -1 | 1) => void;
  onNavigateToPath: (path: string) => void;
}): JSX.Element {
  return (
    <>
      <div className="hidden items-center gap-1 md:flex">
        <Button
          disabled={!displayPath}
          onClick={() => onNavigateToPath(getParentPath(displayPath) ?? "")}
          size="sm"
          type="button"
          variant="outline"
        >
          Parent
        </Button>
        <Button
          disabled={!canNavigateSiblings}
          onClick={() => onNavigateSiblingFolder(-1)}
          size="sm"
          type="button"
          variant="outline"
        >
          Prev folder
        </Button>
        <Button
          disabled={!canNavigateSiblings}
          onClick={() => onNavigateSiblingFolder(1)}
          size="sm"
          type="button"
          variant="outline"
        >
          Next folder
        </Button>
      </div>
      <Breadcrumb className="flex min-w-0 items-center gap-2">
        <Archive className="size-4 shrink-0 text-muted-foreground" />
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                className="max-w-40 min-h-10 cursor-pointer truncate rounded-md px-2 py-1.5"
                onClick={() => onNavigateToPath("")}
                type="button"
              >
                {archiveRoot}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                {index === breadcrumbs.length - 1 ? (
                  <BreadcrumbPage className="max-w-72 truncate px-2 py-1.5" title={crumb.path}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      className="max-w-40 min-h-10 cursor-pointer truncate rounded-md px-2 py-1.5"
                      onClick={() => onNavigateToPath(crumb.path)}
                      title={crumb.path}
                      type="button"
                    >
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </>
  );
}

/** The phone's folder path: one row per level, the archive root first. */
function PathSheet({
  archiveRoot,
  breadcrumbs,
  onNavigateToPath,
  onOpenChange,
  open,
}: {
  archiveRoot: string;
  breadcrumbs: Breadcrumbs;
  onNavigateToPath: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): JSX.Element {
  const navigateAndClose = (path: string) => {
    onNavigateToPath(path);
    onOpenChange(false);
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="p-5" side="bottom">
        <SheetHeader>
          <SheetTitle>Folder path</SheetTitle>
        </SheetHeader>
        <div className="mt-4 grid gap-2">
          <button
            className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
            onClick={() => navigateAndClose("")}
            type="button"
          >
            {archiveRoot}
          </button>
          {breadcrumbs.map((crumb) => (
            <button
              key={crumb.path}
              className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
              onClick={() => navigateAndClose(crumb.path)}
              type="button"
            >
              {crumb.label}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
