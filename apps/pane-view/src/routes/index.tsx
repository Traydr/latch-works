import {
  buildBrowserEntries,
  buildComicEntries,
  type MediaItem,
  sortMediaItems,
} from "@latch-works/media-domain";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  Archive,
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
import { getLibrarySnapshot } from "../features/library/library-service";
import {
  getViewerState,
  saveViewerState,
  type ViewerStateSnapshot,
} from "../features/viewer/viewer-state-service";
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

const sortModes = ["name-asc", "date-newest", "random"] as const;

function PaneViewHome() {
  const library = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [recursive, setRecursive] = useState(true);
  const [comicMode, setComicMode] = useState(false);
  const [sortMode, setSortMode] = useState<(typeof sortModes)[number]>("name-asc");
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
    () => sortMediaItems(library.media, sortMode, 42),
    [library.media, sortMode],
  );
  const visibleMedia = useMemo(
    () =>
      recursive
        ? sortedMedia
        : sortedMedia.filter((item) => item.parentPath === library.currentPath),
    [library.currentPath, recursive, sortedMedia],
  );
  const comics = useMemo(
    () => buildComicEntries(visibleMedia, library.currentPath),
    [library.currentPath, visibleMedia],
  );
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
  const selectedOriginalUrl = selected ? `/api/media/${selected.id}/original` : null;
  const canRenderOriginal = selected ? isUuid(selected.id) : false;

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

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Archive roots">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            LW
          </div>
          <div>
            <strong>Pane View</strong>
            <span>Latch Works</span>
          </div>
        </div>

        <nav className="path-list" aria-label="Known archive paths">
          {library.roots.map((path) => (
            <button
              className={path === library.currentPath ? "path-item active" : "path-item"}
              key={path}
              onClick={() => navigateToPath(path)}
              type="button"
            >
              <Folder size={16} />
              <span>{path}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span>{library.stats.archiveSize}</span>
          <span>{library.stats.monthlyGrowth}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <nav className="crumbs" aria-label="Current path">
            <Archive size={17} />
            <span>{library.archiveRoot}</span>
            <ChevronRight size={15} />
            <strong>{library.currentPath}</strong>
          </nav>

          <div className="toolbar-actions">
            <form className="search-box" onSubmit={submitSearch}>
              <Search size={16} />
              <input
                aria-label="Search archive"
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Search paths"
                type="search"
                value={searchDraft}
              />
            </form>
            <button
              aria-pressed={recursive}
              className={recursive ? "tool-button active" : "tool-button"}
              onClick={() => setRecursive((value) => !value)}
              title="Recursive browsing"
              type="button"
            >
              <ListTree size={17} />
            </button>
            <button
              aria-pressed={comicMode}
              className={comicMode ? "tool-button active" : "tool-button"}
              onClick={() => setComicMode((value) => !value)}
              title="Comic grouping"
              type="button"
            >
              <ImageIcon size={17} />
            </button>
            <button
              className="tool-button"
              onClick={() => setSortMode((value) => (value === "random" ? "name-asc" : "random"))}
              title="Shuffle sort"
              type="button"
            >
              <Shuffle size={17} />
            </button>
            <button className="tool-button" title="Refresh" type="button">
              <RefreshCcw size={17} />
            </button>
            <form action="/api/auth/logout" method="post">
              <button className="tool-button" title="Sign out" type="submit">
                <LogOut size={17} />
              </button>
            </form>
          </div>
        </header>

        <div className="content-grid">
          <section className="browser-panel" aria-label="Archive browser">
            <div className="browser-header">
              <div>
                <h1>{library.currentPath}</h1>
                <p>
                  {entries.length} entries
                  {search.q ? ` matching ${search.q}` : ", path order preserved"}
                </p>
              </div>
              <select
                aria-label="Sort mode"
                onChange={(event) => setSortMode(event.target.value as (typeof sortModes)[number])}
                value={sortMode}
              >
                <option value="name-asc">Name</option>
                <option value="date-newest">Newest</option>
                <option value="random">Random</option>
              </select>
            </div>

            <div className="media-grid">
              {entries.map((entry) => {
                if (entry.kind === "folder") {
                  return (
                    <button
                      className="tile folder-tile"
                      key={entry.key}
                      onClick={() => navigateToPath(entry.path)}
                      type="button"
                    >
                      <Folder size={24} />
                      <strong>{entry.name}</strong>
                      <span>{entry.path}</span>
                    </button>
                  );
                }

                if (entry.kind === "comic") {
                  return (
                    <button
                      className="tile media-tile"
                      key={entry.key}
                      onClick={() => selectMedia(entry.comic.cover.id)}
                      type="button"
                    >
                      <div className="poster image-poster">
                        <ImageIcon size={26} />
                      </div>
                      <strong>{entry.comic.name}</strong>
                      <span>{entry.comic.pages.length} pages</span>
                    </button>
                  );
                }

                return (
                  <button
                    className={
                      entry.media.id === selected?.id
                        ? "tile media-tile selected"
                        : "tile media-tile"
                    }
                    key={entry.key}
                    onClick={() => selectMedia(entry.media.id)}
                    type="button"
                  >
                    <div className={`poster ${entry.media.mediaType}-poster`}>
                      {entry.media.mediaType === "video" ? <Play size={28} /> : null}
                      {entry.media.mediaType === "story" ? <FileText size={28} /> : null}
                      {entry.media.mediaType === "image" ? <ImageIcon size={28} /> : null}
                    </div>
                    <strong>{entry.media.name}</strong>
                    <span>{entry.media.parentPath}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="viewer-panel" aria-label="Selected media">
            {selected ? (
              <>
                <div className={`viewer-stage ${selected.mediaType}-stage`}>
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
                <div className="metadata-list">
                  <div>
                    <span>Name</span>
                    <strong>{selected.name}</strong>
                  </div>
                  <div>
                    <span>Path</span>
                    <strong>{selected.path}</strong>
                  </div>
                  <div>
                    <span>Type</span>
                    <strong>{selected.mediaType}</strong>
                  </div>
                  <div>
                    <span>Delivery</span>
                    <strong>{library.mediaUrlMode}</strong>
                  </div>
                  {viewerState ? (
                    <div>
                      <span>Resume</span>
                      <strong>{formatViewerState(selected, viewerState)}</strong>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </aside>
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
        className="viewer-media"
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
    return <iframe className="viewer-media" onLoad={markViewed} src={src} title={media.name} />;
  }

  return <img alt={media.name} className="viewer-media" onLoad={markViewed} src={src} />;
}

function MediaPlaceholder({ mediaType }: { mediaType: "image" | "story" | "video" }) {
  if (mediaType === "video") {
    return <Play size={42} />;
  }

  if (mediaType === "story") {
    return <FileText size={42} />;
  }

  return <ImageIcon size={42} />;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function formatViewerState(media: MediaItem, state: ViewerStateSnapshot): string {
  if (media.mediaType === "video" && state.positionMs) {
    return `Resume at ${formatDuration(state.positionMs)}`;
  }

  if (media.mediaType === "story" && state.page) {
    return `Page ${state.page}`;
  }

  return `Viewed ${state.updatedAt.slice(0, 16).replace("T", " ")}`;
}

function formatDuration(positionMs: number): string {
  const totalSeconds = Math.floor(positionMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
