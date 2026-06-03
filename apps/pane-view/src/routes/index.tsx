import type { GallerySortMode } from "@latch-works/media-domain";
import {
  type BrowserEntry,
  buildBrowserEntries,
  buildComicEntries,
  createRandomSeed,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Archive, Folder, Search } from "lucide-react";
import { type FormEvent, Fragment, useEffect, useMemo, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { getLibrarySnapshot } from "../features/library/library-service";
import { getViewerState, type ViewerStateSnapshot } from "../features/viewer/viewer-state-service";
import { isCurrentWebSessionValid } from "../server/auth/web-session";

export const Route = createFileRoute("/")({
  validateSearch: (search): { media?: string; path?: string; q?: string } => ({
    media: normalizeSearchParam(search.media),
    path: normalizeSearchParam(search.path),
    q: normalizeSearchParam(search.q),
  }),
  loaderDeps: ({ search }) => ({
    path: search.path,
    query: search.q,
  }),
  loader: async ({ deps }) => {
    if (!(await isCurrentWebSessionValid())) {
      throw redirect({ to: "/login" });
    }

    return getLibrarySnapshot({ data: deps });
  },
  component: PaneViewHome,
});

function PaneViewHome() {
  const library = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [recursive, setRecursive] = useState(true);
  const [comicMode, setComicMode] = useState(false);
  const [sortMode, setSortMode] = useState<GallerySortMode>("name-asc");
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(
    search.media ?? library.media[0]?.id ?? null,
  );
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [, setViewerState] = useState<ViewerStateSnapshot | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    setSearchDraft(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    const selectedFromSearch = search.media
      ? library.media.find((item) => item.id === search.media)
      : null;
    const nextSelectedId = selectedFromSearch?.id ?? library.media[0]?.id ?? null;

    setSelectedId((currentId) => {
      if (!search.media && currentId && library.media.some((item) => item.id === currentId)) {
        return currentId;
      }

      return nextSelectedId;
    });
  }, [library.media, search.media]);

  const sortedMedia = useMemo(
    () => sortMediaItems(library.media, sortMode, randomSeed),
    [library.media, randomSeed, sortMode],
  );
  const visibleMedia = useMemo(
    () =>
      recursive
        ? sortedMedia
        : sortedMedia.filter((item) => item.parentPath === library.currentPath),
    [library.currentPath, recursive, sortedMedia],
  );
  const comics = useMemo(() => {
    const groupedComics = buildComicEntries(visibleMedia, null);
    return sortComicEntries(groupedComics, sortMode, randomSeed);
  }, [randomSeed, sortMode, visibleMedia]);
  const entries = useMemo(
    () =>
      buildBrowserEntries({
        folders: library.folders,
        comics,
        items: visibleMedia,
        recursive,
        comicMode,
        sortMode,
      }),
    [comicMode, comics, library.folders, recursive, sortMode, visibleMedia],
  );
  const selected = visibleMedia.find((item) => item.id === selectedId) ?? visibleMedia[0] ?? null;
  const selectedIndex = selected ? visibleMedia.findIndex((item) => item.id === selected.id) : -1;

  useEffect(() => {
    let cancelled = false;

    if (!selected) {
      setViewerState(null);
      return;
    }

    void getViewerState({
      data: {
        subjectId: selected.id,
        subjectType: "library_entry",
      },
    }).then((state) => {
      if (!cancelled) {
        setViewerState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectAdjacentMedia(1);
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectAdjacentMedia(-1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const navigateToPath = (path: string) => {
    void navigate({
      search: {
        media: undefined,
        path,
        q: search.q,
      },
      to: "/",
    });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = searchDraft.trim();
    void navigate({
      search: {
        media: undefined,
        path: library.currentPath,
        q: nextQuery || undefined,
      },
      to: "/",
    });
  };

  const selectMedia = (mediaId: string) => {
    setSelectedId(mediaId);
    void navigate({
      search: {
        media: mediaId,
        path: library.currentPath,
        q: search.q,
      },
      to: "/",
    });
  };

  const selectAdjacentMedia = (offset: -1 | 1) => {
    if (!visibleMedia.length) {
      return;
    }

    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = (currentIndex + offset + visibleMedia.length) % visibleMedia.length;
    const next = visibleMedia[nextIndex];
    if (next) {
      selectMedia(next.id);
    }
  };

  const shuffle = () => {
    setSortMode("random");
    setRandomSeed(createRandomSeed());
  };

  const handleSelectEntry = (entry: BrowserEntry) => {
    if (entry.kind === "folder") {
      navigateToPath(entry.path);
    } else if (entry.kind === "comic") {
      selectMedia(entry.comic.cover.id);
    } else {
      selectMedia(entry.media.id);
    }
  };

  const handleActivateEntry = (entry: BrowserEntry) => {
    if (entry.kind === "folder") {
      navigateToPath(entry.path);
    } else if (entry.kind === "comic") {
      const idx = visibleMedia.findIndex((m) => m.id === entry.comic.cover.id);
      if (idx >= 0) {
        setViewerOpen(true);
      }
    } else {
      const idx = visibleMedia.findIndex((m) => m.id === entry.media.id);
      if (idx >= 0) {
        setViewerOpen(true);
      }
    }
  };

  const breadcrumbs = useMemo(
    () => buildBreadcrumbItems(library.currentPath),
    [library.currentPath],
  );

  return (
    <SidebarProvider
      className="min-h-screen overflow-hidden bg-background text-foreground"
      defaultOpen
    >
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
                    isActive={!library.currentPath}
                    onClick={() => navigateToPath("")}
                    title="Archive root"
                    tooltip="Archive root"
                  >
                    <Archive className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">Archive root</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {library.roots.map((path) => (
                  <SidebarMenuItem key={path}>
                    <SidebarMenuButton
                      isActive={path === library.currentPath}
                      onClick={() => navigateToPath(path)}
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

      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5">
          <Breadcrumb className="flex min-w-0 items-center gap-2">
            <Archive className="size-4 shrink-0 text-muted-foreground" />
            <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <button
                    className="max-w-40 truncate"
                    onClick={() => navigateToPath("")}
                    type="button"
                  >
                    {library.archiveRoot}
                  </button>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {breadcrumbs.map((crumb, index) => (
                <Fragment key={crumb.path}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0">
                    {index === breadcrumbs.length - 1 ? (
                      <BreadcrumbPage className="max-w-72 truncate" title={crumb.path}>
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <button
                          className="max-w-40 truncate"
                          onClick={() => navigateToPath(crumb.path)}
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

          <form
            className="relative hidden w-72 shrink-0 items-center md:flex"
            onSubmit={submitSearch}
          >
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search archive"
              className="pl-8"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
          </form>
        </header>

        <div className="flex min-h-0 flex-1">
          <BrowserGrid
            comicMode={comicMode}
            entries={entries}
            onActivateEntry={handleActivateEntry}
            onSelectEntry={handleSelectEntry}
            selectedId={selectedId}
          />

          <DetailPanel
            onNext={() => selectAdjacentMedia(1)}
            onOpenViewer={() => setViewerOpen(true)}
            onPrev={() => selectAdjacentMedia(-1)}
            selected={selected}
          />
        </div>

        <FloatingToolbar
          comicMode={comicMode}
          onToggleComicMode={() => setComicMode((v) => !v)}
          onToggleRecursive={() => setRecursive((v) => !v)}
          recursive={recursive}
          shuffle={shuffle}
          sortMode={sortMode}
        />
      </SidebarInset>

      {viewerOpen && selected ? (
        <MediaViewerModal
          items={visibleMedia}
          onClose={() => setViewerOpen(false)}
          startIndex={selectedIndex >= 0 ? selectedIndex : 0}
        />
      ) : null}
    </SidebarProvider>
  );
}

function normalizeSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildBreadcrumbItems(path: string): Array<{ label: string; path: string }> {
  if (!path) {
    return [{ label: "Archive root", path: "" }];
  }

  const segments = path.split("/").filter(Boolean);
  return segments.map((segment, index) => ({
    label: segment,
    path: segments.slice(0, index + 1).join("/"),
  }));
}
