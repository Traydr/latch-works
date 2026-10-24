import {
  type AudioState,
  AudioStateSchema,
  type FileFilter,
  type FileFlag,
  FileFlagSchema,
  type FileFormat,
  type FileId,
  type FileKind,
  FileKindSchema,
  type FileRow,
  MAX_BULK_FILES,
  type OptimizeCategory,
  type RootId,
  type SelectionSummary,
  type VideoCodecChoice,
} from "@latch-works/glazier-core/contract";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MenuEntry } from "../../shared/messages";
import { type FileListQuery, FileTable } from "../components/FileTable";
import { useToasts } from "../components/Toasts";
import { Dropdown, Kbd, MenuCheck, ViewHeader } from "../components/ui";
import { useActions } from "../lib/actions";
import { call, desktop } from "../lib/api";
import { useCommandHandler } from "../lib/commands";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatLabel, plural } from "../lib/format";
import { isCommandKey, useViewKeys } from "../lib/hotkeys";
import { EMPTY_PRESET, useNavigation } from "../lib/navigation";
import { usePreferFolder } from "../lib/preferences";

const KIND_LABELS = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  pdf: "PDFs",
  other: "Other",
  junk: "System junk",
} as const satisfies Record<FileKind, string>;

const AUDIO_LABELS = {
  none: "No audio track",
  silent: "Silent track",
  sound: "Has sound",
  unmeasured: "Not measured yet",
} as const satisfies Record<AudioState, string>;

const FLAG_LABELS = {
  duplicate: "Duplicates",
  convertible: "Can be converted",
  "extension-mismatch": "Wrong extension",
  undecodable: "Won't open",
  "zero-byte": "Empty files",
  animated: "Animated",
  unsupported: "No app shows these",
  junk: "System junk",
} as const satisfies Record<FileFlag, string>;

/** The Issues menu; junk is a kind, so the Kind menu covers it. */
const ISSUE_FLAGS = FileFlagSchema.options.filter((flag) => flag !== "junk");

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

function toggled<T>(values: readonly T[], value: T, on: boolean): T[] {
  const without = values.filter((entry) => entry !== value);

  return on ? [...without, value] : without;
}

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

function menuLabel(name: string, values: readonly string[]): string {
  if (values.length === 0) {
    return name;
  }

  return values.length === 1 ? `${name}: ${values[0]}` : `${name}: ${values.length}`;
}

export function LibraryView({ rootId }: { rootId: RootId }) {
  const { preset, searchRequested, clearSearchRequest } = useNavigation();
  const { report, capabilities, settings } = useEngine();
  const actions = useActions();
  const toasts = useToasts();
  const preferFolder = usePreferFolder(rootId);
  const searchInput = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState<FileListQuery>(() => ({
    rootId,
    ...EMPTY_PRESET,
    ...preset,
    sort: "path",
    descending: false,
  }));

  const [search, setSearch] = useState(preset.search);
  const [selected, setSelected] = useState<Set<FileId>>(new Set());
  const [totals, setTotals] = useState<{ total: number; bytes: number } | null>(null);
  const [summary, setSummary] = useState<SelectionSummary | null>(null);
  const [single, setSingle] = useState<FileRow | null>(null);
  const [renaming, setRenaming] = useState<FileId | null>(null);
  const facets = useEngineQuery("fileFacets", filterOf(query));
  const folders = useEngineQuery("listFolders", { rootId });
  const [folderSearch, setFolderSearch] = useState("");

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

  // What the selection holds, so the bar offers only what applies.
  useEffect(() => {
    if (selected.size === 0) {
      setSummary(null);
      setSingle(null);

      return;
    }

    let cancelled = false;
    const ids = [...selected];

    const timer = window.setTimeout(() => {
      call("selectionSummary", { fileIds: ids.slice(0, MAX_BULK_FILES) }).then(
        (result) => !cancelled && setSummary(result),
        () => undefined,
      );

      if (ids.length === 1) {
        call("getFiles", { ids }).then(
          (rows) => !cancelled && setSingle(rows[0] ?? null),
          () => undefined,
        );
      } else {
        setSingle(null);
      }
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected]);

  const onTotals = useCallback((next: { total: number; bytes: number }) => setTotals(next), []);
  const ids = [...selected];

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

  const runAndClear = async (request: Parameters<typeof actions.perform>[0]) => {
    const plan = await actions.perform(request);

    if (plan) {
      setSelected(new Set());
    }
  };

  const hold = () => {
    if (ids.length > 0) {
      void runAndClear({ kind: "hold", fileIds: ids });
    }
  };

  const moveTo = async () => {
    if (ids.length === 0) {
      return;
    }

    const targetDir = await desktop.pickFolder().catch(report);

    if (targetDir) {
      await runAndClear({ kind: "move", fileIds: ids, targetDir });
    }
  };

  const convert = () =>
    void runAndClear({ kind: "optimize", rootId, categories: [...ALL_CATEGORIES], fileIds: ids });

  const reencode = (codec: VideoCodecChoice) =>
    void runAndClear({
      kind: "reencode",
      fileIds: ids,
      codec,
      quality: settings?.reencodeQuality ?? "high",
    });

  const moreEntries = (row: FileRow | null): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    const target = row ?? single;

    if (target) {
      entries.push(
        { type: "item", id: "quick-look", label: "Quick Look", accelerator: "Space" },
        { type: "item", id: "open", label: "Open" },
        { type: "item", id: "reveal", label: "Show in Finder", accelerator: "Shift+CmdOrCtrl+R" },
        { type: "separator" },
      );
    }

    if (summary && summary.convertible.files > 0) {
      entries.push({
        type: "item",
        id: "convert",
        label: `Convert ${formatCount(summary.convertible.files)} to AVIF or MP4`,
      });
    }

    if (summary && summary.videos > 0) {
      entries.push({
        type: "submenu",
        label: `Re-encode ${plural(summary.videos, "video")} as`,
        items: CODECS.map((codec) => ({
          type: "item" as const,
          id: `reencode:${codec.value}`,
          label: codec.label,
          enabled: capabilities?.video[codec.value] ?? false,
          sublabel: "note" in codec ? codec.note : undefined,
        })),
      });
    }

    if (summary && summary.withAudio > 0) {
      entries.push({
        type: "item",
        id: "strip-audio",
        label: `Remove the audio track from ${plural(summary.withAudio, "video")}`,
      });
    }

    if (summary && summary.extensionMismatches > 0) {
      entries.push({
        type: "item",
        id: "fix-extension",
        label: `Fix ${plural(summary.extensionMismatches, "extension")}`,
      });
    }

    if (target && ids.length <= 1) {
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

  const runMenu = async (row: FileRow | null) => {
    const target = row ?? single;
    const choice = await desktop.showMenu(moreEntries(row));

    if (choice === null) {
      return;
    }

    if (choice.startsWith("reencode:")) {
      const codec = CODECS.find((entry) => `reencode:${entry.value}` === choice);

      if (codec) {
        reencode(codec.value);
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
      case "convert":
        convert();
        break;
      case "strip-audio":
        void runAndClear({ kind: "strip-audio", fileIds: ids });
        break;
      case "fix-extension":
        void runAndClear({ kind: "fix-extension", fileIds: ids });
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
          setQuery((current) => ({ ...current, dir: target.dir }));
        }

        break;
      case "move":
        void moveTo();
        break;
      case "hold":
        hold();
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

    if (!isCommandKey(event) || ids.length === 0) {
      return false;
    }

    if (event.key === "Backspace") {
      hold();

      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "m") {
      void moveTo();

      return true;
    }

    if (event.shiftKey && event.key.toLowerCase() === "r" && single) {
      void desktop.reveal(single.absPath);

      return true;
    }

    return false;
  }, renaming === null);

  const filtered =
    query.kinds.length +
      query.formats.length +
      query.audioStates.length +
      query.flags.length +
      (query.dir ? 1 : 0) +
      (query.search ? 1 : 0) >
    0;

  const facetCount = <T,>(list: ReadonlyArray<{ value: T; files: number }> | undefined, value: T) =>
    list?.find((entry) => entry.value === value)?.files ?? 0;

  const folderMatches = (folders.data ?? [])
    .filter((folder) => folder.toLowerCase().includes(folderSearch.toLowerCase()))
    .slice(0, 200);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Library"
        meta={totals ? `${plural(totals.total, "file")} · ${formatBytes(totals.bytes)}` : null}
      >
        <label className="relative block w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            ref={searchInput}
            className="ls-input h-[26px] py-0 text-xs"
            style={{ paddingLeft: 26, paddingRight: 24 }}
            placeholder="Search names and paths"
            aria-label="Search names and paths"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearch("");
                event.currentTarget.blur();
              }
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
            <Kbd>/</Kbd>
          </span>
        </label>

        <Dropdown
          label={menuLabel(
            "Kind",
            query.kinds.map((kind) => KIND_LABELS[kind]),
          )}
          active={query.kinds.length > 0}
        >
          {() =>
            FileKindSchema.options.map((kind) => (
              <MenuCheck
                key={kind}
                label={KIND_LABELS[kind]}
                count={formatCount(facetCount(facets.data?.kinds, kind))}
                checked={query.kinds.includes(kind)}
                onChange={(on) =>
                  setQuery((current) => ({ ...current, kinds: toggled(current.kinds, kind, on) }))
                }
              />
            ))
          }
        </Dropdown>

        <Dropdown
          label={menuLabel(
            "Format",
            query.formats.map((format) => formatLabel(format)),
          )}
          active={query.formats.length > 0}
        >
          {() => (
            <div className="max-h-80 overflow-y-auto">
              {(facets.data?.formats ?? []).flatMap((entry) =>
                entry.value === null
                  ? []
                  : [
                      <MenuCheck
                        key={entry.value}
                        label={formatLabel(entry.value)}
                        count={`${formatCount(entry.files)} · ${formatBytes(entry.bytes)}`}
                        checked={query.formats.includes(entry.value)}
                        onChange={(on) => {
                          const format: FileFormat | null = entry.value;

                          if (format !== null) {
                            setQuery((current) => ({
                              ...current,
                              formats: toggled(current.formats, format, on),
                            }));
                          }
                        }}
                      />,
                    ],
              )}
              {query.formats
                .filter((format) => !facets.data?.formats.some((entry) => entry.value === format))
                .map((format) => (
                  <MenuCheck
                    key={format}
                    label={formatLabel(format)}
                    count="0"
                    checked
                    onChange={() =>
                      setQuery((current) => ({
                        ...current,
                        formats: current.formats.filter((entry) => entry !== format),
                      }))
                    }
                  />
                ))}
            </div>
          )}
        </Dropdown>

        <Dropdown
          label={menuLabel(
            "Sound",
            query.audioStates.map((state) => AUDIO_LABELS[state]),
          )}
          active={query.audioStates.length > 0}
        >
          {() =>
            AudioStateSchema.options.map((state) => (
              <MenuCheck
                key={state}
                label={AUDIO_LABELS[state]}
                count={formatCount(facetCount(facets.data?.audioStates, state))}
                checked={query.audioStates.includes(state)}
                onChange={(on) =>
                  setQuery((current) => ({
                    ...current,
                    audioStates: toggled(current.audioStates, state, on),
                  }))
                }
              />
            ))
          }
        </Dropdown>

        <Dropdown
          label={menuLabel(
            "Issues",
            query.flags.map((flag) => FLAG_LABELS[flag]),
          )}
          active={query.flags.length > 0}
        >
          {() =>
            ISSUE_FLAGS.map((flag) => (
              <MenuCheck
                key={flag}
                label={FLAG_LABELS[flag]}
                count={formatCount(facetCount(facets.data?.flags, flag))}
                checked={query.flags.includes(flag)}
                onChange={(on) =>
                  setQuery((current) => ({ ...current, flags: toggled(current.flags, flag, on) }))
                }
              />
            ))
          }
        </Dropdown>

        <Dropdown
          label={query.dir ? `Folder: ${query.dir.split("/").at(-1)}` : "Folder"}
          active={query.dir !== null}
        >
          {(close) => (
            <div className="w-72">
              <input
                className="ls-input mb-1 h-[26px] py-0 text-xs"
                placeholder="Find a folder"
                aria-label="Find a folder"
                value={folderSearch}
                onChange={(event) => setFolderSearch(event.target.value)}
              />
              <div className="max-h-72 overflow-y-auto">
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  onClick={() => {
                    setQuery((current) => ({ ...current, dir: null }));
                    close();
                  }}
                >
                  All folders
                </button>
                {folderMatches.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    aria-pressed={query.dir === folder}
                    className={`ls-mono block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      query.dir === folder ? "text-violet-700 dark:text-violet-300" : ""
                    }`}
                    onClick={() => {
                      setQuery((current) => ({ ...current, dir: folder }));
                      close();
                    }}
                  >
                    {folder}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Dropdown>

        {filtered ? (
          <button
            type="button"
            className="ls-btn ls-btn-ghost"
            onClick={() => {
              setSearch("");
              setQuery((current) => ({ ...current, ...EMPTY_PRESET, rootId }));
            }}
          >
            <X className="size-3.5" /> Clear
          </button>
        ) : null}
      </ViewHeader>

      <FileTable
        query={query}
        selected={selected}
        onSelect={setSelected}
        onSelectAll={() => void selectAll()}
        onSort={(sort, descending) => setQuery((current) => ({ ...current, sort, descending }))}
        onTotals={onTotals}
        onOpen={(row) => void desktop.open(row.absPath)}
        onQuickLook={(row) => void desktop.quickLook(row.absPath)}
        onContextMenu={(row) => void runMenu(row)}
        renaming={renaming}
        onRenameStart={(row) => setRenaming(row.id)}
        onRenameEnd={(row, name) => {
          setRenaming(null);

          if (name) {
            void actions.perform({ kind: "rename", renames: [{ fileId: row.id, name }] });
          }
        }}
      />

      {selected.size > 0 ? (
        <div className="flex shrink-0 items-center gap-1.5 border-t ls-divider bg-zinc-50 px-4 py-2 dark:bg-zinc-900/60">
          <span className="ls-mono mr-2 text-[10.5px] text-zinc-600 tabular dark:text-zinc-300">
            {formatCount(selected.size)} selected
            {summary ? ` · ${formatBytes(summary.bytes)}` : ""}
          </span>
          {summary && summary.convertible.files > 0 ? (
            <button type="button" className="ls-btn ls-btn-cta" onClick={convert}>
              Convert {formatCount(summary.convertible.files)}
            </button>
          ) : null}
          <button type="button" className="ls-btn ls-btn-danger" onClick={hold}>
            Move to holding <Kbd>⌘⌫</Kbd>
          </button>
          <button type="button" className="ls-btn" onClick={() => void moveTo()}>
            Move to… <Kbd>⇧⌘M</Kbd>
          </button>
          <button type="button" className="ls-btn" onClick={() => void runMenu(null)}>
            More…
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-ghost ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear <Kbd>Esc</Kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}
