import {
  type BrowserEntry,
  buildBrowserEntries,
  buildComicEntries,
  createRandomSeed,
  type GallerySortMode,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Archive, Search } from "lucide-react";
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Input } from "@/components/ui/input";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ArchiveSidebar } from "@/features/gallery/ArchiveSidebar";
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { useGalleryState } from "@/features/gallery/useGalleryState";
import { getLibrarySnapshot } from "../features/library/library-service";
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

  const persisted = useGalleryState();

  const [recursive, setRecursive] = useState(persisted.recursive);
  const [comicMode, setComicMode] = useState(persisted.comicMode);
  const [sortMode, setSortMode] = useState<GallerySortMode>(persisted.sortMode);
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(
    search.media ?? library.media[0]?.id ?? null,
  );
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);

  // Redirect to persisted path on first visit if URL has no path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run once on mount to restore persisted path.
  useEffect(() => {
    if (!search.path && persisted.lastPath) {
      void navigate({
        search: { media: undefined, path: persisted.lastPath, q: search.q },
        to: "/",
      });
    }
  }, []);

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
      recursive || search.q
        ? sortedMedia
        : sortedMedia.filter((item) => item.parentPath === library.currentPath),
    [library.currentPath, recursive, search.q, sortedMedia],
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

  useEffect(() => {
    setFocusedEntryIndex((currentIndex) => {
      if (entries.length === 0) {
        return 0;
      }

      return Math.min(currentIndex, entries.length - 1);
    });
  }, [entries]);

  const selected = visibleMedia.find((item) => item.id === selectedId) ?? visibleMedia[0] ?? null;
  const selectedIndex = selected ? visibleMedia.findIndex((item) => item.id === selected.id) : -1;

  // Persist state changes.
  useEffect(() => {
    persisted.setLastPath(library.currentPath);
  }, [library.currentPath, persisted.setLastPath]);

  useEffect(() => {
    persisted.setLastSelectedId(selectedId);
  }, [selectedId, persisted.setLastSelectedId]);

  useEffect(() => {
    persisted.setRecursive(recursive);
  }, [recursive, persisted.setRecursive]);

  useEffect(() => {
    persisted.setComicMode(comicMode);
  }, [comicMode, persisted.setComicMode]);

  useEffect(() => {
    persisted.setSortMode(sortMode);
  }, [sortMode, persisted.setSortMode]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) {
        return;
      }

      if (viewerOpen) {
        handleViewerKeyDown(event);
        return;
      }

      handleGalleryKeyDown(event);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (viewerOpen) {
        handleViewerKeyUp(event);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  });

  const handleGalleryKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    // Folder navigation with Shift (check before plain WASD).
    if (event.shiftKey) {
      if (key === "w") {
        event.preventDefault();
        const parent = getParentPath(library.currentPath);
        navigateToPath(parent ?? "");
        return;
      }
      if (key === "s") {
        event.preventDefault();
        const entry = entries[focusedEntryIndex];
        if (entry?.kind === "folder") {
          navigateToPath(entry.path);
        }
        return;
      }
      if (key === "a") {
        event.preventDefault();
        navigateSiblingFolder(-1);
        return;
      }
      if (key === "d") {
        event.preventDefault();
        navigateSiblingFolder(1);
        return;
      }
    }

    // Navigation.
    if (key === "ArrowRight" || key === "d") {
      event.preventDefault();
      moveGridFocus(1, 0);
      return;
    }
    if (key === "ArrowLeft" || key === "a") {
      event.preventDefault();
      moveGridFocus(-1, 0);
      return;
    }
    if (key === "ArrowDown" || key === "s") {
      event.preventDefault();
      moveGridFocus(0, 1);
      return;
    }
    if (key === "ArrowUp" || key === "w") {
      event.preventDefault();
      moveGridFocus(0, -1);
      return;
    }

    // Activate.
    if (key === "Enter" || key === "f") {
      event.preventDefault();
      const entry = entries[focusedEntryIndex];
      if (entry) {
        handleActivateEntry(entry);
      }
      return;
    }
  };

  const handleViewerKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (key === "Escape") {
      event.preventDefault();
      setViewerOpen(false);
      return;
    }
    if (key === "ArrowRight" || key === "e") {
      event.preventDefault();
      selectAdjacentMedia(1);
      return;
    }
    if (key === "ArrowLeft" || key === "q") {
      event.preventDefault();
      selectAdjacentMedia(-1);
      return;
    }
    if (key === " " || key === "2") {
      event.preventDefault();
      // Play/pause handled inside MediaViewerModal.
      return;
    }
    if (key === "1") {
      event.preventDefault();
      // Seek backward handled inside MediaViewerModal.
      return;
    }
    if (key === "3") {
      event.preventDefault();
      // Seek forward handled inside MediaViewerModal.
      return;
    }
    if (key === "4") {
      event.preventDefault();
      // Temporary speed boost handled inside MediaViewerModal.
      return;
    }
  };

  const handleViewerKeyUp = (event: KeyboardEvent) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === "4") {
      // Release speed boost handled inside MediaViewerModal.
    }
  };

  const columnCountRef = useRef(4);

  const moveGridFocus = (dx: number, dy: number) => {
    if (!entries.length) {
      return;
    }

    const columnCount = columnCountRef.current;
    const currentRow = Math.floor(focusedEntryIndex / columnCount);
    const currentCol = focusedEntryIndex % columnCount;

    const nextRow = currentRow + dy;
    const nextCol = currentCol + dx;
    const nextIndex = nextRow * columnCount + nextCol;

    if (nextIndex >= 0 && nextIndex < entries.length) {
      setFocusedEntryIndex(nextIndex);
      const entry = entries[nextIndex];
      if (entry?.kind === "media") {
        selectMedia(entry.media.id);
      } else if (entry?.kind === "comic") {
        selectMedia(entry.comic.cover.id);
      }
    }
  };

  const navigateToPath = useCallback(
    (path: string) => {
      void navigate({
        search: {
          media: undefined,
          path,
          q: search.q,
        },
        to: "/",
      });
    },
    [navigate, search.q],
  );

  const navigateSiblingFolder = (offset: -1 | 1) => {
    const siblings = library.folders;
    const currentIndex = siblings.findIndex((f) => f.path === library.currentPath);
    if (currentIndex < 0) {
      return;
    }

    const nextIndex = (currentIndex + offset + siblings.length) % siblings.length;
    const next = siblings[nextIndex];
    if (next) {
      navigateToPath(next.path);
    }
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
    const entryIndex = entries.findIndex((candidate) => candidate.key === entry.key);
    if (entryIndex >= 0) {
      setFocusedEntryIndex(entryIndex);
    }

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
      <ArchiveSidebar
        currentPath={library.currentPath}
        folders={library.folders}
        onNavigateToPath={navigateToPath}
      />

      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
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
          </div>

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
            columnCountRef={columnCountRef}
            entries={entries}
            focusedIndex={focusedEntryIndex}
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
          onChangeSortMode={setSortMode}
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

function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT")
  );
}

function getParentPath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : "";
}
