import { formatBytes } from "@latch-works/media-domain";
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import { useIsMobile } from "@/hooks/use-mobile";
import { DeleteOverlay } from "./DeleteOverlay";
import { Poster } from "./Poster";

interface BrowserEntryCardProps {
  cardHeight: number;
  cardWidth: number;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entry: GalleryBrowseEntry;
  focused: boolean;
  left: number;
  onActivate: (entry: GalleryBrowseEntry) => void;
  onSelect: (entry: GalleryBrowseEntry) => void;
  /** Comic cards: the full comic is loading for the reader. */
  opening?: boolean;
  priority?: boolean;
  selected: boolean;
  thumbnailUrls: Readonly<Record<string, string>>;
  top: number;
}

export function BrowserEntryCard({
  cardHeight,
  cardWidth,
  deletedEntryIds,
  deletingEntryIds,
  entry,
  focused,
  left,
  onActivate,
  onSelect,
  opening = false,
  priority = false,
  selected,
  thumbnailUrls,
  top,
}: BrowserEntryCardProps) {
  const isMobile = useIsMobile();

  const handleClick = () => {
    if (isMobile) {
      onActivate(entry);
      return;
    }

    onSelect(entry);
  };

  return (
    <button
      type="button"
      className="absolute cursor-pointer text-left transition"
      onClick={handleClick}
      onDoubleClick={isMobile ? undefined : () => onActivate(entry)}
      onMouseDown={(event) => event.preventDefault()}
      style={{
        width: `${cardWidth}px`,
        height: `${cardHeight}px`,
        left: `${left}px`,
        top: `${top}px`,
      }}
    >
      {entry.kind === "folder" ? (
        <FolderCard entry={entry} focused={focused} selected={selected} />
      ) : entry.kind === "comic" ? (
        <ComicCard
          cardWidth={cardWidth}
          deletedEntryIds={deletedEntryIds}
          deletingEntryIds={deletingEntryIds}
          entry={entry}
          focused={focused}
          opening={opening}
          priority={priority}
          selected={selected}
          thumbnailUrls={thumbnailUrls}
        />
      ) : (
        <MediaCard
          cardWidth={cardWidth}
          deletedEntryIds={deletedEntryIds}
          deletingEntryIds={deletingEntryIds}
          entry={entry}
          focused={focused}
          priority={priority}
          selected={selected}
          thumbnailUrls={thumbnailUrls}
        />
      )}
    </button>
  );
}

function FolderCard({
  entry,
  focused,
  selected,
}: {
  entry: Extract<GalleryBrowseEntry, { kind: "folder" }>;
  focused: boolean;
  selected: boolean;
}) {
  return (
    <div
      className={`flex h-full w-full flex-col justify-between overflow-hidden rounded-2xl border p-4 transition ${
        selected
          ? "border-violet-400 bg-violet-50/90 dark:border-violet-500 dark:bg-violet-500/15"
          : focused
            ? "ring-2 ring-violet-400 ring-offset-2 ring-offset-zinc-950"
            : "border-zinc-300/80 bg-white/75 hover:-translate-y-0.5 hover:border-zinc-400 hover:bg-white hover:shadow-lg dark:border-zinc-700/80 dark:bg-zinc-900/75 dark:hover:border-zinc-600 dark:hover:bg-zinc-900"
      }`}
      title={entry.path}
    >
      <div className="flex items-start justify-between gap-3">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-10 w-10 text-amber-500 transition group-hover:scale-105"
          role="img"
          aria-label="Folder"
        >
          <title>Folder</title>
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
          FOLDER
        </span>
      </div>
      <div className="space-y-1">
        <p className="line-clamp-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          {entry.name}
        </p>
      </div>
    </div>
  );
}

function ComicCard({
  cardWidth,
  deletedEntryIds,
  deletingEntryIds,
  entry,
  focused,
  opening,
  priority,
  selected,
  thumbnailUrls,
}: {
  cardWidth: number;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entry: Extract<GalleryBrowseEntry, { kind: "comic" }>;
  focused: boolean;
  opening: boolean;
  priority?: boolean;
  selected: boolean;
  thumbnailUrls: Readonly<Record<string, string>>;
}) {
  const comic = entry.comic;
  // Summaries carry only the cover; the overlays follow it. Deleting a whole
  // comic is folder deletion and is not offered from the gallery.
  const isDeleting = deletingEntryIds.has(comic.cover.id);
  const isDeleted = deletedEntryIds.has(comic.cover.id);

  return (
    <div
      className={`group relative h-full w-full overflow-hidden rounded-2xl bg-zinc-800 text-left transition outline outline-1 outline-black/10 dark:outline-white/10 ${
        selected
          ? "ring-2 ring-violet-500 ring-offset-2 ring-offset-zinc-950"
          : focused
            ? "ring-2 ring-violet-400 ring-offset-2 ring-offset-zinc-950"
            : "hover:shadow-lg"
      }`}
      title={comic.folderPath}
    >
      <Poster
        cardWidth={cardWidth}
        media={comic.cover}
        priority={priority}
        resolvedThumbnailUrl={thumbnailUrls[comic.cover.id]}
      />
      {isDeleting || isDeleted ? <DeleteOverlay animated={isDeleting} /> : null}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/10 to-transparent">
        <div className="px-3 pb-3">
          <p className="line-clamp-2 text-sm font-semibold text-white">{comic.name}</p>
          <p className="tabular-nums text-[11px] text-white/75">
            {opening ? "Opening…" : `${comic.pageCount} pages`}
          </p>
        </div>
      </div>
    </div>
  );
}

function MediaCard({
  cardWidth,
  deletedEntryIds,
  deletingEntryIds,
  entry,
  focused,
  priority,
  selected,
  thumbnailUrls,
}: {
  cardWidth: number;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  entry: Extract<GalleryBrowseEntry, { kind: "media" }>;
  focused: boolean;
  priority?: boolean;
  selected: boolean;
  thumbnailUrls: Readonly<Record<string, string>>;
}) {
  const item = entry.media;
  const isDeleting = deletingEntryIds.has(item.id);
  const isDeleted = deletedEntryIds.has(item.id);

  return (
    <div
      className={`group relative h-full w-full overflow-hidden rounded-2xl text-left transition outline outline-1 outline-black/10 dark:outline-white/10 ${
        selected
          ? "ring-2 ring-violet-500 ring-offset-2 ring-offset-zinc-950"
          : focused
            ? "ring-2 ring-violet-400 ring-offset-2 ring-offset-zinc-950"
            : "hover:shadow-lg"
      }`}
      title={item.path}
    >
      <Poster
        cardWidth={cardWidth}
        media={item}
        priority={priority}
        resolvedThumbnailUrl={thumbnailUrls[item.id]}
      />
      {isDeleting || isDeleted ? <DeleteOverlay animated={isDeleting} /> : null}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100">
        <div className="px-3 pb-3">
          <p className="truncate text-sm font-semibold text-white">{item.name}</p>
          <p className="text-[11px] text-white/70">
            {formatBytes(item.size)}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
          </p>
        </div>
      </div>
      {item.mediaType === "video" ? (
        <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          VIDEO
        </span>
      ) : null}
    </div>
  );
}
