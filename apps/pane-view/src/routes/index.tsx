import {
  buildBrowserEntries,
  buildComicEntries,
  createRandomSeed,
  type MediaItem,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  ImageIcon,
  ListTree,
  LogOut,
  Play,
  RefreshCcw,
  Search,
  Shuffle,
} from "lucide-react";
import { type FormEvent, type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../components/ui/breadcrumb";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
} from "../components/ui/sidebar";
import { getLibrarySnapshot } from "../features/library/library-service";
import {
  getViewerState,
  saveViewerState,
  type ViewerStateSnapshot,
} from "../features/viewer/viewer-state-service";
import { cn } from "../lib/cn";
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

const sortModes = ["name-asc", "name-desc", "date-newest", "date-oldest", "random"] as const;
type SortMode = (typeof sortModes)[number];

const sortLabels: Record<SortMode, string> = {
  "date-newest": "Newest",
  "date-oldest": "Oldest",
  "name-asc": "A-Z",
  "name-desc": "Z-A",
  random: "Random",
};

function PaneViewHome() {
  const library = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [recursive, setRecursive] = useState(true);
  const [comicMode, setComicMode] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("name-asc");
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(
    search.media ?? library.media[0]?.id ?? null,
  );
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [viewerState, setViewerState] = useState<ViewerStateSnapshot | null>(null);

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
  const selectedOriginalUrl = selected ? `/api/media/${selected.id}/original` : null;
  const canRenderOriginal = selected ? isUuid(selected.id) : false;
  const currentPathLabel = library.currentPath || "Archive root";
  const breadcrumbs = useMemo(
    () => buildBreadcrumbItems(library.currentPath),
    [library.currentPath],
  );

  useEffect(() => {
    let cancelled = false;

    if (!selected || !isUuid(selected.id)) {
      setViewerState(null);
      return;
    }

    void getViewerState({
      data: {
        subjectId: selected.id,
        subjectType: "media",
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

  return (
    <main className="flex min-h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <Sidebar className="hidden md:flex" aria-label="Archive roots">
        <SidebarHeader>
          <div className="flex items-center gap-3">
            <div
              className="grid size-9 place-items-center rounded-md border border-zinc-700 text-xs font-bold text-amber-300"
              aria-hidden="true"
            >
              LW
            </div>
            <div className="min-w-0">
              <strong className="block truncate text-sm font-semibold">Pane View</strong>
              <span className="block truncate text-xs text-zinc-400">Latch Works</span>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarMenu aria-label="Known archive paths">
            <SidebarMenuButton
              isActive={!library.currentPath}
              onClick={() => navigateToPath("")}
              title="Archive root"
            >
              <Archive className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Archive root</span>
            </SidebarMenuButton>
            {library.roots.map((path) => (
              <SidebarMenuButton
                isActive={path === library.currentPath}
                key={path}
                onClick={() => navigateToPath(path)}
                title={path}
              >
                <Folder className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{path}</span>
              </SidebarMenuButton>
            ))}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>

      <section className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-950 px-5">
          <Breadcrumb className="flex min-w-0 items-center gap-2">
            <Archive className="size-4 shrink-0 text-zinc-500" />
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink onClick={() => navigateToPath("")}>
                  {library.archiveRoot}
                </BreadcrumbLink>
              </BreadcrumbItem>
              {breadcrumbs.map((crumb, index) => (
                <BreadcrumbItem key={crumb.path}>
                  <BreadcrumbSeparator />
                  {index === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage title={crumb.path}>{crumb.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink onClick={() => navigateToPath(crumb.path)} title={crumb.path}>
                      {crumb.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>

          <form
            className="hidden h-9 w-72 shrink-0 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-zinc-400 md:flex"
            onSubmit={submitSearch}
          >
            <Search className="size-4" />
            <input
              aria-label="Search archive"
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
          </form>
        </header>

        <div className="flex min-h-0 flex-1">
          <section
            className="min-w-0 flex-1 overflow-auto px-5 pb-28 pt-5"
            aria-label="Archive browser"
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <p className="m-0 min-w-0 truncate text-sm text-zinc-400">
                <span className="font-medium text-zinc-100">{entries.length}</span> entries in{" "}
                <span className="text-zinc-200">{currentPathLabel}</span>
                {search.q ? <span> matching {search.q}</span> : null}
              </p>
              <select
                aria-label="Sort mode"
                className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none"
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                value={sortMode}
              >
                {sortModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {sortLabels[mode]}
                  </option>
                ))}
              </select>
            </div>

            {entries.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {entries.map((entry) => {
                  if (entry.kind === "folder") {
                    return (
                      <button
                        className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left transition-colors hover:border-zinc-700"
                        key={entry.key}
                        onClick={() => navigateToPath(entry.path)}
                        title={entry.path}
                        type="button"
                      >
                        <Folder className="size-5 text-zinc-400" />
                        <strong className="min-w-0 truncate text-sm font-semibold">
                          {entry.name}
                        </strong>
                        <span className="col-start-2 min-w-0 truncate text-xs text-zinc-500">
                          {entry.path}
                        </span>
                      </button>
                    );
                  }

                  if (entry.kind === "comic") {
                    return (
                      <button
                        className={cn(
                          "group min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left transition-colors hover:border-zinc-700",
                          entry.comic.pages.some((page) => page.id === selected?.id) &&
                            "border-amber-300",
                        )}
                        key={entry.key}
                        onClick={() => selectMedia(entry.comic.cover.id)}
                        title={entry.comic.folderPath}
                        type="button"
                      >
                        <Poster media={entry.comic.cover} />
                        <div className="grid gap-1 p-2.5">
                          <strong className="min-w-0 truncate text-sm font-semibold">
                            {entry.comic.name}
                          </strong>
                          <span className="text-xs text-zinc-500">
                            {entry.comic.pages.length} pages
                          </span>
                        </div>
                      </button>
                    );
                  }

                  return (
                    <button
                      className={cn(
                        "group min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left transition-colors hover:border-zinc-700",
                        entry.media.id === selected?.id && "border-amber-300",
                      )}
                      key={entry.key}
                      onClick={() => selectMedia(entry.media.id)}
                      title={entry.media.path}
                      type="button"
                    >
                      <Poster media={entry.media} />
                      <div className="grid gap-1 p-2.5">
                        <strong className="min-w-0 truncate text-sm font-semibold">
                          {entry.media.name}
                        </strong>
                        <span className="min-w-0 truncate text-xs text-zinc-500">
                          {entry.media.parentPath}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="grid min-h-60 place-items-center rounded-lg border border-dashed border-zinc-800 text-center">
                <div className="grid max-w-xs justify-items-center gap-2 text-sm text-zinc-400">
                  <Archive className="size-6" />
                  <strong className="text-zinc-100">No archive entries</strong>
                  <span>
                    {search.q
                      ? "No folders or media matched the current search."
                      : "Sync media or choose another archive path."}
                  </span>
                </div>
              </div>
            )}
          </section>

          <aside
            className="hidden w-[360px] shrink-0 border-l border-zinc-800 bg-zinc-950 p-5 lg:block"
            aria-label="Selected media"
          >
            {selected ? (
              <div className="grid gap-4">
                <div className="grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
                  {canRenderOriginal && selectedOriginalUrl ? (
                    <SelectedMediaPreview
                      key={selected.id}
                      media={selected}
                      onStateSaved={setViewerState}
                      resumeState={viewerState}
                      src={selectedOriginalUrl}
                    />
                  ) : (
                    <MediaPlaceholder mediaType={selected.mediaType} />
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="grid h-9 flex-1 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
                    onClick={() => selectAdjacentMedia(-1)}
                    title="Previous"
                    type="button"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    className="grid h-9 flex-1 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
                    onClick={() => selectAdjacentMedia(1)}
                    title="Next"
                    type="button"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>

                <dl className="grid gap-3 text-sm">
                  <MetadataItem label="Name" value={selected.name} />
                  <MetadataItem label="Path" value={selected.path} />
                  <MetadataItem label="Type" value={selected.mediaType} />
                </dl>
              </div>
            ) : (
              <div className="grid min-h-96 place-items-center rounded-lg border border-dashed border-zinc-800 text-center">
                <div className="grid max-w-56 justify-items-center gap-2 text-sm text-zinc-400">
                  <ImageIcon className="size-8" />
                  <strong className="text-zinc-100">No media selected</strong>
                  <span>Choose an image, video, or story from the browser.</span>
                </div>
              </div>
            )}
          </aside>
        </div>

        <div className="pointer-events-none fixed bottom-5 left-1/2 z-20 -translate-x-1/2">
          <div className="pointer-events-auto flex max-w-[96vw] items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/95 px-3 py-2 shadow-lg">
            <button
              aria-pressed={recursive}
              className={toolButtonClass(recursive)}
              onClick={() => setRecursive((value) => !value)}
              title="Recursive browsing"
              type="button"
            >
              <ListTree className="size-4" />
              <span className="hidden sm:inline">Recursive</span>
            </button>
            <button
              aria-pressed={comicMode}
              className={toolButtonClass(comicMode)}
              onClick={() => setComicMode((value) => !value)}
              title="Comic grouping"
              type="button"
            >
              <ImageIcon className="size-4" />
              <span className="hidden sm:inline">Comic</span>
            </button>
            <button
              aria-pressed={sortMode === "random"}
              className={toolButtonClass(sortMode === "random")}
              onClick={shuffle}
              title={sortMode === "random" ? "Shuffle again" : "Random sort"}
              type="button"
            >
              <Shuffle className="size-4" />
              <span className="hidden sm:inline">Shuffle</span>
            </button>
            <div className="h-5 w-px bg-zinc-800" />
            <button
              className={toolButtonClass(false)}
              onClick={() => void router.invalidate()}
              title="Refresh"
              type="button"
            >
              <RefreshCcw className="size-4" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <form action="/api/auth/logout" method="post">
              <button className={toolButtonClass(false)} title="Sign out" type="submit">
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

function normalizeSearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function SelectedMediaPreview({
  media,
  onStateSaved,
  resumeState,
  src,
}: {
  media: MediaItem;
  onStateSaved: (state: ViewerStateSnapshot | null) => void;
  resumeState: ViewerStateSnapshot | null;
  src: string;
}) {
  const lastSavedPositionMs = useRef(resumeState?.positionMs ?? 0);
  const restoredPosition = useRef(false);

  useEffect(() => {
    lastSavedPositionMs.current = resumeState?.positionMs ?? 0;
    restoredPosition.current = false;
  }, [resumeState?.positionMs]);

  if (media.mediaType === "video") {
    const savePosition = (video: HTMLVideoElement) => {
      const positionMs = Math.floor(video.currentTime * 1000);
      if (
        !Number.isFinite(positionMs) ||
        Math.abs(positionMs - lastSavedPositionMs.current) < 5000
      ) {
        return;
      }

      lastSavedPositionMs.current = positionMs;
      void saveViewerState({
        data: {
          positionMs,
          subjectId: media.id,
          subjectType: "media",
        },
      }).then(onStateSaved);
    };

    const restorePosition = (event: SyntheticEvent<HTMLVideoElement>) => {
      if (restoredPosition.current || !resumeState?.positionMs) {
        return;
      }

      const video = event.currentTarget;
      const positionSeconds = resumeState.positionMs / 1000;
      if (positionSeconds > 1 && positionSeconds < video.duration) {
        video.currentTime = positionSeconds;
      }
      restoredPosition.current = true;
    };

    return (
      // biome-ignore lint/a11y/useMediaCaption: Caption sidecars are not ingested yet.
      <video
        className="h-full w-full border-0 object-contain"
        controls
        onLoadedMetadata={restorePosition}
        onPause={(event) => savePosition(event.currentTarget)}
        onTimeUpdate={(event) => savePosition(event.currentTarget)}
        preload="metadata"
        src={src}
      />
    );
  }

  const markViewed = () => {
    void saveViewerState({
      data: {
        page: media.mediaType === "story" ? (resumeState?.page ?? 1) : undefined,
        subjectId: media.id,
        subjectType: "media",
      },
    }).then(onStateSaved);
  };

  if (media.mediaType === "story") {
    return (
      <iframe
        className="h-full w-full border-0 object-contain"
        onLoad={markViewed}
        src={src}
        title={media.name}
      />
    );
  }

  return (
    <img alt={media.name} className="h-full w-full object-contain" onLoad={markViewed} src={src} />
  );
}

function MediaPlaceholder({
  mediaType,
  size = 42,
}: {
  mediaType: "image" | "story" | "video";
  size?: number;
}) {
  if (mediaType === "video") {
    return <Play size={size} />;
  }

  if (mediaType === "story") {
    return <FileText size={size} />;
  }

  return <ImageIcon size={size} />;
}

function Poster({ media }: { media: MediaItem }) {
  const thumbnailUrl = readThumbnailUrl(media);

  return (
    <div
      className={cn(
        "grid aspect-[4/3] place-items-center overflow-hidden border-b border-zinc-800 bg-zinc-900 text-zinc-500",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "story" && "text-red-300",
      )}
    >
      {thumbnailUrl ? (
        <img alt="" className="h-full w-full object-cover" loading="lazy" src={thumbnailUrl} />
      ) : (
        <MediaPlaceholder mediaType={media.mediaType} size={28} />
      )}
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-zinc-800 pb-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="m-0 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
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

function toolButtonClass(active: boolean): string {
  return cn(
    "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
    active
      ? "border-amber-300 bg-amber-300 text-zinc-950"
      : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:text-zinc-50",
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readThumbnailUrl(media: MediaItem): string | undefined {
  if (!("thumbnailUrl" in media) || typeof media.thumbnailUrl !== "string") {
    return undefined;
  }

  return media.thumbnailUrl;
}
