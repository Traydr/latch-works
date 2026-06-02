import { buildBrowserEntries, buildComicEntries, sortMediaItems } from "@latch-works/media-domain";
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
import { useMemo, useState } from "react";
import { getLibrarySnapshot } from "../features/library/library-service";
import { isCurrentWebSessionValid } from "../server/auth/web-session";

export const Route = createFileRoute("/")({
  loader: async () => {
    if (!(await isCurrentWebSessionValid())) {
      throw redirect({ to: "/login" });
    }

    return getLibrarySnapshot();
  },
  component: PaneViewHome,
});

const sortModes = ["name-asc", "date-newest", "random"] as const;

function PaneViewHome() {
  const library = Route.useLoaderData();
  const [recursive, setRecursive] = useState(true);
  const [comicMode, setComicMode] = useState(false);
  const [sortMode, setSortMode] = useState<(typeof sortModes)[number]>("name-asc");
  const [selectedId, setSelectedId] = useState<string | null>(library.media[0]?.id ?? null);

  const sortedMedia = useMemo(
    () => sortMediaItems(library.media, sortMode, 42),
    [library.media, sortMode],
  );
  const comics = useMemo(
    () => buildComicEntries(sortedMedia, library.currentPath),
    [library.currentPath, sortedMedia],
  );
  const entries = useMemo(
    () =>
      buildBrowserEntries({
        folders: library.folders,
        comics,
        items: sortedMedia,
        recursive,
        comicMode,
        sortMode,
      }),
    [comicMode, comics, library.folders, recursive, sortMode, sortedMedia],
  );
  const selected = sortedMedia.find((item) => item.id === selectedId) ?? sortedMedia[0] ?? null;

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
            <label className="search-box">
              <Search size={16} />
              <input aria-label="Search archive" placeholder="Search paths" type="search" />
            </label>
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
                <p>{entries.length} entries, path order preserved</p>
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
                    <button className="tile folder-tile" key={entry.key} type="button">
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
                      onClick={() => setSelectedId(entry.comic.cover.id)}
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
                    onClick={() => setSelectedId(entry.media.id)}
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
                  {selected.mediaType === "video" ? <Play size={42} /> : null}
                  {selected.mediaType === "story" ? <FileText size={42} /> : null}
                  {selected.mediaType === "image" ? <ImageIcon size={42} /> : null}
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
                </div>
              </>
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
}
