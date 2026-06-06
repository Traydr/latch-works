import {
  type BrowserEntry,
  buildBrowserEntries,
  buildComicEntries,
  type ComicEntry,
  createRandomSeed,
  type GallerySortMode,
  type MediaItem,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
import { createFileRoute, redirect, useRouterState } from "@tanstack/react-router";
import { Archive, ChevronUp, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { ArchiveSidebar } from "@/features/gallery/ArchiveSidebar";
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryPending } from "@/features/gallery/GalleryPending";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { useGalleryState } from "@/features/gallery/useGalleryState";
import { ComicReader } from "@/features/comics/ComicReader";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import { ThemeSync } from "@/features/settings/ThemeSync";
import { useAppSettings, resolveRootKey, useRootPreferences } from "@/features/settings/useAppSettings";
import { getLibrarySnapshot } from "../features/library/library-service";
import { isCurrentWebSessionValid } from "../server/auth/web-session";

export const Route = createFileRoute("/")({
  validateSearch: (
    search,
  ): { comic?: boolean; media?: string; path?: string; q?: string; recursive?: boolean } => ({
    comic: normalizeBooleanSearchParam(search.comic),
    media: normalizeSearchParam(search.media),
    path: normalizeSearchParam(search.path),
    q: normalizeSearchParam(search.q),
    recursive: normalizeBooleanSearchParam(search.recursive),
  }),
  loaderDeps: ({ search }) => ({
    comicMode: search.comic ?? false,
    path: search.path,
    query: search.q,
    recursive: search.recursive ?? false,
  }),
  loader: async ({ deps }) => {
    if (!(await isCurrentWebSessionValid())) {
      throw redirect({ to: "/login" });
    }

    return getLibrarySnapshot({ data: deps });
  },
  pendingComponent: GalleryPending,
  component: PaneViewHome,
});

function PaneViewHome() {
  const library = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const persisted = useGalleryState();
  const { settings, updateSettings } = useAppSettings();
  const rootKey = resolveRootKey(library.currentPath);
  const { savePreferences: saveRootPreferences } = useRootPreferences(rootKey);
  const isMobile = useIsMobile();
  const isRefreshing = useRouterState({ select: (state) => state.isLoading });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);

  const [recursive, setRecursive] = useState(search.recursive ?? persisted.recursive);
  const [comicMode, setComicMode] = useState(search.comic ?? persisted.comicMode);
  const [detailPanelOpen, setDetailPanelOpen] = useState(persisted.detailPanelOpen);
  const [sortMode, setSortMode] = useState<GallerySortMode>(persisted.sortMode);
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(
    search.media ?? library.media[0]?.id ?? null,
  );
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerItems, setViewerItems] = useState<MediaItem[] | null>(null);
  /** When set, gallery selection stays on this id while the viewer pages through `viewerItems`. */
  const [viewerLockedMediaId, setViewerLockedMediaId] = useState<string | null>(null);
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollFocusedIntoView, setScrollFocusedIntoView] = useState(false);

  const showDetailPanel = !isMobile && detailPanelOpen;

  const buildBrowseSearch = useCallback(
    (patch: {
      comic?: boolean;
      media?: string;
      path?: string;
      q?: string;
      recursive?: boolean;
    }) => ({
      comic: (patch.comic ?? comicMode) || undefined,
      media: patch.media,
      path: patch.path ?? library.currentPath,
      q: patch.q ?? search.q,
      recursive: (patch.recursive ?? recursive) || undefined,
    }),
    [comicMode, library.currentPath, recursive, search.q],
  );

  // Redirect to persisted path on first visit if URL has no path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only run once on mount to restore persisted path.
  useEffect(() => {
    if (!search.path && persisted.lastPath) {
      void navigate({
        search: buildBrowseSearch({
          media: undefined,
          path: persisted.lastPath,
        }),
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

  const effectiveRecursive = recursive || comicMode;
  const recursiveToggleDisabled = library.currentPath === "";

  useEffect(() => {
    if (library.currentPath === "" && recursive) {
      setRecursive(false);
    }
  }, [library.currentPath, recursive]);

  const sortedMedia = useMemo(
    () => sortMediaItems(library.media, sortMode, randomSeed),
    [library.media, randomSeed, sortMode],
  );
  const filteredMedia = useMemo(
    () =>
      sortedMedia.filter((item) => {
        if (item.mediaType === "video" && !settings.showVideos) {
          return false;
        }

        if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
          return false;
        }

        return true;
      }),
    [settings.showImages, settings.showVideos, sortedMedia],
  );
  const visibleMedia = filteredMedia;
  const comics = useMemo(() => {
    if (!comicMode) {
      return [];
    }

    const groupedComics = buildComicEntries(visibleMedia, library.currentPath || null, {
      folders: library.allFolders,
      leafFoldersOnly: true,
    });
    return sortComicEntries(groupedComics, sortMode, randomSeed);
  }, [comicMode, library.allFolders, library.currentPath, randomSeed, sortMode, visibleMedia]);
  const entries = useMemo(
    () =>
      buildBrowserEntries({
        folders: library.folders,
        comics,
        items: visibleMedia,
        recursive: effectiveRecursive,
        comicMode,
        sortMode,
      }),
    [comicMode, comics, effectiveRecursive, library.folders, sortMode, visibleMedia],
  );

  useEffect(() => {
    setFocusedEntryIndex((currentIndex) => {
      if (entries.length === 0) {
        return 0;
      }

      return Math.min(currentIndex, entries.length - 1);
    });
  }, [entries]);

  const selected =
    visibleMedia.find((item) => item.id === (viewerLockedMediaId ?? selectedId)) ??
    visibleMedia[0] ??
    null;
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
    saveRootPreferences({
      comicMode,
      recursive,
      sortMode,
    });
  }, [comicMode, recursive, saveRootPreferences, sortMode]);

  useEffect(() => {
    persisted.setComicMode(comicMode);
  }, [comicMode, persisted.setComicMode]);

  useEffect(() => {
    persisted.setSortMode(sortMode);
  }, [sortMode, persisted.setSortMode]);

  useEffect(() => {
    persisted.setDetailPanelOpen(detailPanelOpen);
  }, [detailPanelOpen, persisted.setDetailPanelOpen]);

  useEffect(() => {
    const urlRecursive = search.recursive ?? false;
    const urlComic = search.comic ?? false;
    if (urlRecursive === recursive && urlComic === comicMode) {
      return;
    }

    void navigate({
      search: buildBrowseSearch({}),
      to: "/",
      replace: true,
      resetScroll: false,
    });
  }, [buildBrowseSearch, comicMode, navigate, recursive, search.comic, search.recursive]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || hotkeysOpen || mobileSearchOpen || pathSheetOpen) {
        if (event.key === "Escape") {
          setSettingsOpen(false);
          setHotkeysOpen(false);
          setMobileSearchOpen(false);
          setPathSheetOpen(false);
        }
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setHotkeysOpen(true);
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
      closeViewer();
      return;
    }
    if (key === "ArrowRight" || key === "e") {
      event.preventDefault();
      if (!viewerLockedMediaId) {
        selectAdjacentMedia(1);
      }
      return;
    }
    if (key === "ArrowLeft" || key === "q") {
      event.preventDefault();
      if (!viewerLockedMediaId) {
        selectAdjacentMedia(-1);
      }
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

    if (nextIndex < 0 || nextIndex >= entries.length) {
      if (entries.length === 0) {
        return;
      }

      const wrappedIndex =
        nextIndex < 0 ? entries.length - 1 : nextIndex >= entries.length ? 0 : nextIndex;
      setFocusedEntryIndex(wrappedIndex);
      setScrollFocusedIntoView(true);
      const wrappedEntry = entries[wrappedIndex];
      if (wrappedEntry?.kind === "media") {
        selectMedia(wrappedEntry.media.id);
      } else if (wrappedEntry?.kind === "comic") {
        selectMedia(wrappedEntry.comic.cover.id);
      }
      return;
    }

    if (nextIndex >= 0 && nextIndex < entries.length) {
      setFocusedEntryIndex(nextIndex);
      setScrollFocusedIntoView(true);
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
      const nextRecursive = path === "" ? false : recursive;
      if (path === "" && recursive) {
        setRecursive(false);
      }

      void navigate({
        search: buildBrowseSearch({
          media: undefined,
          path,
          recursive: nextRecursive,
        }),
        to: "/",
      });
    },
    [buildBrowseSearch, comicMode, navigate, recursive, search.q],
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
      search: buildBrowseSearch({
        media: undefined,
        path: library.currentPath,
        q: nextQuery || undefined,
      }),
      to: "/",
    });
  };

  const selectMedia = (mediaId: string) => {
    setSelectedId(mediaId);
    void navigate({
      search: buildBrowseSearch({
        media: mediaId,
      }),
      to: "/",
      replace: true,
      resetScroll: false,
    });
  };

  const selectAdjacentMedia = (offset: -1 | 1) => {
    if (viewerLockedMediaId || !visibleMedia.length) {
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

  const openViewer = (
    items: MediaItem[],
    startMediaId: string,
    options?: { lockSelectionToMediaId?: string },
  ) => {
    const startIndex = items.findIndex((item) => item.id === startMediaId);
    if (startIndex < 0) {
      return;
    }

    setViewerItems(items);
    setViewerLockedMediaId(options?.lockSelectionToMediaId ?? null);
    setSelectedId(options?.lockSelectionToMediaId ?? startMediaId);
    setViewerOpen(true);
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setViewerItems(null);
    setViewerLockedMediaId(null);
  };

  const handleActivateEntry = (entry: BrowserEntry) => {
    if (entry.kind === "folder") {
      navigateToPath(entry.path);
    } else if (entry.kind === "comic") {
      setActiveComic(entry.comic);
    } else {
      openViewer(visibleMedia, entry.media.id);
    }
  };

  const breadcrumbs = useMemo(
    () => buildBreadcrumbItems(library.currentPath),
    [library.currentPath],
  );

  const currentFolderName =
    breadcrumbs[breadcrumbs.length - 1]?.label ?? library.archiveRoot;
  const parentPath = getParentPath(library.currentPath);

  return (
    <SidebarProvider
      className="min-h-screen overflow-hidden bg-background text-foreground"
      defaultOpen
    >
      <ThemeSync theme={settings.theme} />
      <ArchiveSidebar
        currentPath={library.currentPath}
        folders={library.folders}
        onNavigateToPath={navigateToPath}
      />

      <SidebarInset className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-auto min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <SidebarTrigger className="-ml-1 shrink-0" />
            {isMobile ? (
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <Button
                    disabled={!parentPath && library.currentPath === ""}
                    onClick={() => navigateToPath(parentPath ?? "")}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <button
                    className="min-w-0 flex-1 truncate text-left text-base font-semibold"
                    onClick={() => setPathSheetOpen(true)}
                    type="button"
                  >
                    {currentFolderName}
                  </button>
                </div>
                {library.currentPath ? (
                  <p className="truncate text-xs text-muted-foreground">{library.currentPath}</p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="hidden items-center gap-1 md:flex">
                  <Button
                    disabled={!library.currentPath}
                    onClick={() => navigateToPath(parentPath ?? "")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Parent
                  </Button>
                  <Button onClick={() => navigateSiblingFolder(-1)} size="sm" type="button" variant="outline">
                    Prev folder
                  </Button>
                  <Button onClick={() => navigateSiblingFolder(1)} size="sm" type="button" variant="outline">
                    Next folder
                  </Button>
                </div>
                <Breadcrumb className="flex min-w-0 items-center gap-2">
                  <Archive className="size-4 shrink-0 text-muted-foreground" />
                  <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
                    <BreadcrumbItem>
                      <BreadcrumbLink asChild>
                        <button
                          className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
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
                            <BreadcrumbPage
                              className="max-w-72 truncate px-2 py-1.5"
                              title={crumb.path}
                            >
                              {crumb.label}
                            </BreadcrumbPage>
                          ) : (
                            <BreadcrumbLink asChild>
                              <button
                                className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
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
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              className="md:hidden"
              onClick={() => setMobileSearchOpen(true)}
              size="icon"
              type="button"
              variant="outline"
            >
              <Search className="size-4" />
            </Button>
            <form
              className="relative hidden w-72 items-center md:flex"
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
            <Button
              aria-expanded={showDetailPanel}
              aria-label={showDetailPanel ? "Hide preview panel" : "Show preview panel"}
              className="hidden shrink-0 lg:inline-flex"
              onClick={() => setDetailPanelOpen((open) => !open)}
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

        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <BrowserGrid
            cardWidth={settings.thumbnailSize}
            comicMode={comicMode}
            columnCountRef={columnCountRef}
            entries={entries}
            focusedIndex={focusedEntryIndex}
            onActivateEntry={handleActivateEntry}
            onScrolledToFocus={() => setScrollFocusedIntoView(false)}
            onSelectEntry={handleSelectEntry}
            scrollFocusedIntoView={scrollFocusedIntoView}
            selectedId={viewerLockedMediaId ?? selectedId}
          />

          {showDetailPanel ? (
            <DetailPanel
              onCopyPath={() => {
                if (selected) {
                  void navigator.clipboard.writeText(selected.path);
                }
              }}
              onDownload={() => {
                if (selected) {
                  window.open(`/api/media/${selected.id}/original`, "_blank", "noopener,noreferrer");
                }
              }}
              onNext={() => selectAdjacentMedia(1)}
              onOpenViewer={() => {
                if (selected) {
                  openViewer(visibleMedia, selected.id);
                }
              }}
              onPrev={() => selectAdjacentMedia(-1)}
              selected={selected}
            />
          ) : null}
        </div>

        <FloatingToolbar
          comicMode={comicMode}
          currentPath={library.currentPath}
          isRefreshing={isRefreshing}
          onChangeSortMode={setSortMode}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleComicMode={() => {
            if (library.currentPath === "") {
              return;
            }

            setComicMode((current) => {
              const next = !current;
              if (next) {
                setRecursive(true);
              } else {
                setRecursive(false);
              }
              return next;
            });
          }}
          onToggleRecursive={() => {
            if (library.currentPath === "") {
              return;
            }

            setRecursive((current) => {
              const next = !current;
              if (!next) {
                setComicMode(false);
              }
              return next;
            });
          }}
          recursive={recursive}
          recursiveDisabled={recursiveToggleDisabled}
          shuffle={shuffle}
          sortMode={sortMode}
        />
      </SidebarInset>

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        onUpdate={updateSettings}
        onUpdateRecursiveDefault={setRecursive}
        open={settingsOpen}
        recursiveDefault={recursive}
        settings={settings}
      />

      {hotkeysOpen ? <HotkeyOverlay onClose={() => setHotkeysOpen(false)} /> : null}

      <Sheet onOpenChange={setMobileSearchOpen} open={mobileSearchOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Search archive</SheetTitle>
          </SheetHeader>
          <form className="mt-4 grid gap-3" onSubmit={submitSearch}>
            <Input
              aria-label="Search archive"
              autoFocus
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
            <Button type="submit">Search</Button>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={setPathSheetOpen} open={pathSheetOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Folder path</SheetTitle>
          </SheetHeader>
          <div className="mt-4 grid gap-2">
            <button
              className="rounded-lg border border-border px-3 py-2 text-left text-sm"
              onClick={() => {
                navigateToPath("");
                setPathSheetOpen(false);
              }}
              type="button"
            >
              {library.archiveRoot}
            </button>
            {breadcrumbs.map((crumb) => (
              <button
                key={crumb.path}
                className="rounded-lg border border-border px-3 py-2 text-left text-sm"
                onClick={() => {
                  navigateToPath(crumb.path);
                  setPathSheetOpen(false);
                }}
                type="button"
              >
                {crumb.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {viewerOpen && selected ? (
        <MediaViewerModal
          autoplayVideos={settings.autoplayVideos}
          items={viewerItems ?? visibleMedia}
          loopNavigation={settings.loopNavigation}
          loopVideos={settings.loopVideos}
          onClose={closeViewer}
          startIndex={Math.max(
            0,
            (viewerItems ?? visibleMedia).findIndex((item) => item.id === selected.id),
          )}
        />
      ) : null}

      {activeComic ? <ComicReader comic={activeComic} onClose={() => setActiveComic(null)} /> : null}
    </SidebarProvider>
  );
}

function normalizeSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBooleanSearchParam(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "1") {
    return true;
  }

  if (value === false || value === "false" || value === "0") {
    return false;
  }

  return undefined;
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
