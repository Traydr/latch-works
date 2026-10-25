import {
  type FileFilter,
  type FileId,
  type FileRow,
  MAX_BULK_FILES,
  type OptimizeCategory,
  type PlanRequest,
  type RootId,
  type SelectionSummary,
  type VideoCodecChoice,
} from "@latch-works/glazier-core/contract";
import { FolderOpen, LayoutGrid, List, PanelRight, Search, SearchX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, TopBar } from "../../../../ui/ui";
import type { MenuEntry } from "../../shared/messages";
import { FileTable } from "../components/FileTable";
import { useFolderPicker } from "../components/FolderPicker";
import { FileGrid } from "../components/library/FileGrid";
import {
  activeFilterCount,
  FilterChips,
  FilterMenu,
  type Filters,
} from "../components/library/FilterMenu";
import { Inspector } from "../components/library/Inspector";
import { SelectionBar } from "../components/library/SelectionBar";
import type { FileViewProps } from "../components/library/use-file-cursor";
import { type FileListQuery, useFilePages } from "../components/library/use-file-pages";
import { useToasts } from "../components/Toasts";
import { useActions } from "../lib/actions";
import { call, desktop } from "../lib/api";
import { useCommandHandler } from "../lib/commands";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, plural } from "../lib/format";
import { useOpenInView } from "../lib/hand-off";
import { isCommandKey, isPlainKey, useViewKeys } from "../lib/hotkeys";
import { EMPTY_PRESET, useNavigation } from "../lib/navigation";
import { usePreferFolder } from "../lib/preferences";

const ALL_CATEGORIES = [
  "still-to-avif",
  "animation-to-mp4",
  "video-remux",
  "video-convert",
  "rename-avif",
  "rename-mp4",
] as const satisfies readonly OptimizeCategory[];

const CODECS = [
  { value: "hevc", label: "HEVC" },
  { value: "av1", label: "AV1", note: "Older devices can't play AV1" },
  { value: "avc", label: "H.264" },
] as const satisfies ReadonlyArray<{ value: VideoCodecChoice; label: string; note?: string }>;

type Mode = "list" | "grid";

const NO_FILTERS: Filters = { kinds: [], formats: [], audioStates: [], flags: [], dir: null };

const MODE_KEY = "glazier.library.mode";

const INSPECTOR_KEY = "glazier.library.inspector";

/** Room the selection bar covers at the bottom of the list, so the last rows scroll clear of it. */
const BAR_INSET = 80;

function filterOf(query: FileListQuery): FileFilter {
  return {
    rootId: query.rootId,
    search: query.search,
    kinds: query.kinds,
    formats: query.formats,
    audioStates: query.audioStates,
    flags: query.flags,
    dir: query.dir,
  };
}

/** The last choice of list or grid, kept across launches. */
function storedMode(): Mode {
  return window.localStorage.getItem(MODE_KEY) === "grid" ? "grid" : "list";
}

/** Open by default on a wide window, unless the owner has chosen otherwise. */
function storedInspector(): boolean {
  const stored = window.localStorage.getItem(INSPECTOR_KEY);

  return stored === null ? window.innerWidth >= 1440 : stored === "open";
}

export function LibraryView({ rootId }: { rootId: RootId }) {
  const { preset, searchRequested, clearSearchRequest } = useNavigation();
  const { report, capabilities, settings, roots, catalogVersion } = useEngine();
  const actions = useActions();
  const toasts = useToasts();
  const openInView = useOpenInView();
  const preferFolder = usePreferFolder(rootId);
  const searchInput = useRef<HTMLInputElement>(null);
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;
  const pickFolder = useFolderPicker();
  const rootName = root?.name ?? "Top folder";

  const [query, setQuery] = useState<FileListQuery>(() => ({
    rootId,
    ...EMPTY_PRESET,
    ...preset,
    sort: "path",
    descending: false,
  }));

  const [search, setSearch] = useState(preset.search);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<FileId | null>(null);
  const [summary, setSummary] = useState<SelectionSummary | null>(null);
  const [sample, setSample] = useState<FileRow[]>([]);
  const [mode, setModeState] = useState<Mode>(storedMode);
  const [inspectorOpen, setInspectorOpen] = useState(storedInspector);
  const pages = useFilePages(query);
  const facets = useEngineQuery("fileFacets", filterOf(query));
  const folders = useEngineQuery("listFolders", { rootId });
  const queryKey = JSON.stringify(query);

  // The first page is asked for here as well as by the list, so an empty result (which shows no
  // list) still refreshes when the query or the catalog changes.
  useEffect(() => pages.request(0, 1), [pages.request]);

  const setMode = (next: Mode) => {
    window.localStorage.setItem(MODE_KEY, next);
    setModeState(next);
  };

  const toggleInspector = () => {
    window.localStorage.setItem(INSPECTOR_KEY, inspectorOpen ? "closed" : "open");
    setInspectorOpen(!inspectorOpen);
  };

  // Another view linked here with a filter: apply it.
  useEffect(() => {
    setQuery((current) => ({ ...current, ...EMPTY_PRESET, ...preset, rootId }));
    setSearch(preset.search);
    setSelected(new Set());
  }, [preset, rootId]);

  useEffect(() => {
    if (searchRequested) {
      searchInput.current?.focus();
      searchInput.current?.select();
      clearSearchRequest();
    }
  }, [searchRequested, clearSearchRequest]);

  // Search applies after typing pauses.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery((current) => ({ ...current, search })), 200);

    return () => window.clearTimeout(timer);
  }, [search]);

  // The cursor points into one query's results; a new query starts without one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query's JSON is the trigger.
  useEffect(() => setCursor(null), [queryKey]);

  const cursorRow = cursor === null ? null : pages.rowAt(cursor);

  /** What the inspector and the shortcuts act on: the selection, or else the cursor's file. */
  const cursorId = cursorRow?.id ?? null;

  const targets = useMemo<FileId[]>(
    () => (selected.size > 0 ? [...selected] : cursorId === null ? [] : [cursorId]),
    [selected, cursorId],
  );

  // What the targets hold, so the bar and the inspector offer only what applies. A changed
  // catalog asks again, since a rename or a conversion changes the answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the catalog version is a trigger.
  useEffect(() => {
    if (targets.length === 0) {
      setSummary(null);
      setSample([]);

      return;
    }

    let cancelled = false;

    const timer = window.setTimeout(() => {
      call("selectionSummary", { fileIds: targets.slice(0, MAX_BULK_FILES) }).then(
        (result) => !cancelled && setSummary(result),
        () => undefined,
      );
      call("getFiles", { ids: targets.slice(0, 3) }).then(
        (rows) => !cancelled && setSample(rows),
        () => undefined,
      );
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targets, catalogVersion]);

  const onlySelected = selected.size === 1 ? [...selected][0] : undefined;

  const single =
    selected.size === 0
      ? cursorRow
      : onlySelected === undefined
        ? null
        : cursorRow?.id === onlySelected
          ? cursorRow
          : (sample.find((row) => row.id === onlySelected) ?? null);

  const selectAll = useCallback(async () => {
    try {
      const result = await call("listFileIds", filterOf(query));

      setSelected(new Set(result.ids));

      if (result.truncated) {
        toasts.show({
          message: `Selected the first ${formatCount(MAX_BULK_FILES)} files`,
          detail: "Narrow the filter to act on the rest.",
          tone: "info",
        });
      }
    } catch (error) {
      report(error);
    }
  }, [query, toasts, report]);

  useCommandHandler("select-all", () => void selectAll());

  const runAndClear = async (request: PlanRequest) => {
    const plan = await actions.perform(request);

    if (plan) {
      setSelected(new Set());
    }
  };

  const hold = (fileIds: FileId[]) => {
    if (fileIds.length > 0) {
      void runAndClear({ kind: "hold", fileIds });
    }
  };

  const moveTo = async (fileIds: FileId[]) => {
    if (fileIds.length === 0) {
      return;
    }

    const targetDir = root
      ? await pickFolder({
          title: `Move ${plural(fileIds.length, "file")} to`,
          action: "Move here",
          within: { path: root.path, name: root.name },
        }).catch(report)
      : null;

    if (targetDir) {
      await runAndClear({ kind: "move", fileIds, targetDir });
    }
  };

  const convert = (fileIds: FileId[]) =>
    void runAndClear({ kind: "optimize", rootId, categories: [...ALL_CATEGORIES], fileIds });

  const reveal = () => {
    const row = single ?? sample[0];

    if (row) {
      void desktop.reveal(row.absPath);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setQuery((current) => ({ ...current, ...EMPTY_PRESET, rootId }));
  };

  const changeFilters = (next: Partial<Filters>) =>
    setQuery((current) => ({ ...current, ...next }));

  const moreEntries = (
    fileIds: FileId[],
    target: FileRow | null,
    held: SelectionSummary | null,
  ): MenuEntry[] => {
    const entries: MenuEntry[] = [];

    if (target) {
      entries.push(
        { type: "item", id: "quick-look", label: "Quick Look", accelerator: "Space" },
        { type: "item", id: "open", label: "Open" },
        { type: "item", id: "open-in-view", label: "Open in View" },
        { type: "item", id: "reveal", label: "Show in Finder", accelerator: "Shift+CmdOrCtrl+R" },
        { type: "separator" },
      );
    }

    if (held && held.convertible.files > 0) {
      entries.push({
        type: "item",
        id: "convert",
        label: `Convert ${formatCount(held.convertible.files)} to AVIF or MP4`,
      });
    }

    if (held && held.videos > 0) {
      entries.push({
        type: "submenu",
        label: `Re-encode ${plural(held.videos, "video")} as`,
        items: CODECS.map((codec) => ({
          type: "item" as const,
          id: `reencode:${codec.value}`,
          label: codec.label,
          // AV1 runs on ffmpeg's SVT-AV1 when it has one, and on WebCodecs otherwise.
          enabled:
            (capabilities?.video[codec.value] ?? false) ||
            (codec.value === "av1" && capabilities?.svtAv1 === true),
          sublabel: "note" in codec ? codec.note : undefined,
        })),
      });
    }

    if (held && held.withAudio > 0) {
      entries.push({
        type: "item",
        id: "strip-audio",
        label: `Remove the audio track from ${plural(held.withAudio, "video")}`,
      });
    }

    if (held && held.extensionMismatches > 0) {
      entries.push({
        type: "item",
        id: "fix-extension",
        label: `Fix ${plural(held.extensionMismatches, "extension")}`,
      });
    }

    if (target && fileIds.length <= 1) {
      entries.push(
        { type: "item", id: "rename", label: "Rename", accelerator: "Return" },
        { type: "separator" },
        {
          type: "item",
          id: "prefer",
          label: `Prefer ${target.dir || "the top folder"} for duplicates`,
        },
        { type: "item", id: "folder", label: `Show only ${target.dir || "the top folder"}` },
      );
    }

    entries.push(
      { type: "separator" },
      { type: "item", id: "move", label: "Move to…", accelerator: "Shift+CmdOrCtrl+M" },
      { type: "item", id: "hold", label: "Move to holding", accelerator: "CmdOrCtrl+Backspace" },
    );

    return entries;
  };

  /**
   * The native menu for a right-clicked file or the bar's "⋯". A right-click on a file outside
   * the selection acts on that file alone, so its summary is asked for here rather than read
   * from state that has not caught up yet.
   */
  const runMenu = async (row: FileRow | null) => {
    const fileIds = row && !selected.has(row.id) ? [row.id] : targets;
    const target = row ?? (fileIds.length === 1 ? single : null);

    if (fileIds.length === 0) {
      return;
    }

    const held = await call("selectionSummary", {
      fileIds: fileIds.slice(0, MAX_BULK_FILES),
    }).catch(() => null);

    const choice = await desktop.showMenu(moreEntries(fileIds, target, held));

    if (choice === null) {
      return;
    }

    if (choice.startsWith("reencode:")) {
      const codec = CODECS.find((entry) => `reencode:${entry.value}` === choice);

      if (codec) {
        void runAndClear({
          kind: "reencode",
          fileIds,
          codec: codec.value,
          quality: settings?.reencodeQuality ?? "high",
        });
      }

      return;
    }

    switch (choice) {
      case "quick-look":
        if (target) {
          void desktop.quickLook(target.absPath);
        }

        break;
      case "open":
        if (target) {
          void desktop.open(target.absPath);
        }

        break;
      case "reveal":
        if (target) {
          void desktop.reveal(target.absPath);
        }

        break;
      case "open-in-view":
        if (target) {
          openInView(target.absPath);
        }

        break;
      case "convert":
        convert(fileIds);
        break;
      case "strip-audio":
        void runAndClear({ kind: "strip-audio", fileIds });
        break;
      case "fix-extension":
        void runAndClear({ kind: "fix-extension", fileIds });
        break;
      case "rename":
        if (target) {
          setRenaming(target.id);
        }

        break;
      case "prefer":
        if (target) {
          void preferFolder(target.dir);
        }

        break;
      case "folder":
        if (target) {
          changeFilters({ dir: target.dir });
        }

        break;
      case "move":
        void moveTo(fileIds);
        break;
      case "hold":
        hold(fileIds);
        break;
      default:
        break;
    }
  };

  useViewKeys((event) => {
    if (event.key === "/" && !isCommandKey(event)) {
      searchInput.current?.focus();

      return true;
    }

    if (isPlainKey(event) && !event.shiftKey && event.key.toLowerCase() === "i") {
      toggleInspector();

      return true;
    }

    if (!isCommandKey(event)) {
      return false;
    }

    if (event.key === "Backspace" && selected.size > 0) {
      hold([...selected]);

      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "m" && selected.size > 0) {
      void moveTo([...selected]);

      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "r" && single) {
      void desktop.reveal(single.absPath);

      return true;
    }

    return false;
  }, renaming === null);

  const filters: Filters = {
    kinds: query.kinds,
    formats: query.formats,
    audioStates: query.audioStates,
    flags: query.flags,
    dir: query.dir,
  };

  const filtered = activeFilterCount(filters) > 0 || query.search !== "";
  const barVisible = selected.size > 0 && (!inspectorOpen || selected.size >= 2);

  const caption =
    pages.total === null
      ? null
      : filtered && root
        ? `${formatCount(pages.total)} of ${plural(root.fileCount, "file")} · ${formatBytes(pages.totalBytes)}`
        : `${plural(pages.total, "file")} · ${formatBytes(pages.totalBytes)}`;

  const viewProps: FileViewProps = {
    pages,
    selected,
    onSelect: setSelected,
    cursor,
    onCursor: setCursor,
    onOpen: (row) => void desktop.open(row.absPath),
    onQuickLook: (row) => void desktop.quickLook(row.absPath),
    onContextMenu: (row) => void runMenu(row),
    renaming,
    onRenameStart: (row) => setRenaming(row.id),
    onRenameEnd: (row, name) => {
      setRenaming(null);

      if (name) {
        void actions.perform({ kind: "rename", renames: [{ fileId: row.id, name }] });
      }
    },
    bottomInset: barVisible ? BAR_INSET : 0,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="Library" meta={caption}>
        <label className="relative block w-[260px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            ref={searchInput}
            className="lw-input pr-8 pl-8"
            placeholder="Search names and folders"
            aria-label="Search names and folders"
            title="Search  /"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearch("");
                event.currentTarget.blur();
              }
            }}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear the search"
              className="lw-btn lw-btn-ghost absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-md px-0 [&_svg]:size-3.5"
              onClick={() => {
                setSearch("");
                searchInput.current?.focus();
              }}
            >
              <X />
            </button>
          ) : null}
        </label>

        <FilterMenu
          filters={filters}
          facets={facets.data}
          folders={folders.data ?? []}
          rootName={rootName}
          onChange={changeFilters}
        />

        <fieldset aria-label="Show as" className="lw-seg">
          <button
            type="button"
            aria-pressed={mode === "list"}
            aria-label="List"
            title="List"
            className="lw-seg-item px-2 [&_svg]:size-4"
            onClick={() => setMode("list")}
          >
            <List />
          </button>
          <button
            type="button"
            aria-pressed={mode === "grid"}
            aria-label="Grid"
            title="Grid"
            className="lw-seg-item px-2 [&_svg]:size-4"
            onClick={() => setMode("grid")}
          >
            <LayoutGrid />
          </button>
        </fieldset>

        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label="Inspector"
          title="Inspector  I"
          className="lw-btn lw-btn-ghost lw-btn-icon aria-pressed:bg-zinc-900/[0.06] aria-pressed:text-zinc-900 dark:aria-pressed:bg-white/[0.07] dark:aria-pressed:text-zinc-100"
          onClick={toggleInspector}
        >
          <PanelRight />
        </button>
      </TopBar>

      <FilterChips
        filters={filters}
        rootName={rootName}
        onChange={changeFilters}
        onClear={() => changeFilters(NO_FILTERS)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {pages.total === 0 ? (
            filtered ? (
              <EmptyState
                icon={SearchX}
                title="No files match"
                actions={
                  <button type="button" className="lw-btn lw-btn-secondary" onClick={clearFilters}>
                    Clear filters
                  </button>
                }
              />
            ) : (
              <EmptyState icon={FolderOpen} title="This folder has no files yet" />
            )
          ) : mode === "list" ? (
            <FileTable
              {...viewProps}
              sort={query.sort}
              descending={query.descending}
              onSort={(sort, descending) =>
                setQuery((current) => ({ ...current, sort, descending }))
              }
              onSelectAll={() => void selectAll()}
              rootName={rootName}
            />
          ) : (
            <FileGrid {...viewProps} />
          )}

          {barVisible ? (
            <SelectionBar
              count={selected.size}
              summary={summary}
              onConvert={() => convert([...selected])}
              onHold={() => hold([...selected])}
              onMoveTo={() => void moveTo([...selected])}
              onMore={() => void runMenu(null)}
              onClear={() => setSelected(new Set())}
            />
          ) : null}
        </div>

        {inspectorOpen ? (
          <Inspector
            single={single}
            sample={sample}
            count={targets.length}
            summary={summary}
            primary={!barVisible}
            onConvert={() => convert(targets)}
            onReveal={reveal}
            onOpenInView={() => {
              const row = single ?? sample[0];

              if (row) {
                openInView(row.absPath);
              }
            }}
            onMoveTo={() => void moveTo(targets)}
            onHold={() => hold(targets)}
          />
        ) : null}
      </div>
    </div>
  );
}
