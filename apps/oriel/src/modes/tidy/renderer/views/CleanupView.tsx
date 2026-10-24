import type {
  FileFilter,
  FileFormat,
  FileId,
  FileRow,
  PlanRequest,
  RootId,
} from "@latch-works/glazier-core/contract";
import { Folder, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, Kbd, Spinner, StartTruncate, TopBar } from "../../../../ui/ui";
import { cleanupCount } from "../components/Sidebar";
import { Poster } from "../components/tidy/MediaTile";
import { RunProgress } from "../components/tidy/RunProgress";
import { silentVideoIds } from "../components/tidy/requests";
import { planned, useActions } from "../lib/actions";
import { call } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatDuration, plural } from "../lib/format";
import { isCommandKey, useViewKeys } from "../lib/hotkeys";
import { type LibraryPreset, useNavigation } from "../lib/navigation";

/** Rows shown per section; the rest are a link to the Library. */
const ROW_LIMIT = 50;

const SOURCE = "cleanup";

/** The extension a file of each format is renamed to, as the engine's Clean up names them. */
const PREFERRED_EXTENSION: Partial<Record<FileFormat, string>> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  tiff: "tif",
  avif: "avif",
  heic: "heic",
  psd: "psd",
  svg: "svg",
  mp4: "mp4",
  mov: "mov",
  matroska: "mkv",
  webm: "webm",
  mpegts: "ts",
  avi: "avi",
  flv: "flv",
  asf: "wmv",
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
  flac: "flac",
  ogg: "ogg",
  pdf: "pdf",
  zip: "zip",
  rar: "rar",
  "7z": "7z",
};

function withExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");

  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * The name Clean up gives a file: AVIF and MP4 always under their own extension, anything else
 * under its format's when the one it has is wrong. Null when the name stays.
 */
function fixedName(row: FileRow): string | null {
  const ext = row.ext.toLowerCase();

  if ((row.format === "avif" || row.format === "mp4") && ext !== row.format) {
    return withExtension(row.name, row.format);
  }

  const preferred = row.format === null ? undefined : PREFERRED_EXTENSION[row.format];

  return row.extensionMismatch && preferred !== undefined
    ? withExtension(row.name, preferred)
    : null;
}

const NO_FILTER: Omit<FileFilter, "rootId"> = {
  search: "",
  kinds: [],
  formats: [],
  audioStates: [],
  flags: [],
  dir: null,
};

/** The first page of a list, in path order. */
const FIRST_PAGE = { sort: "path", descending: false, offset: 0, limit: ROW_LIMIT } as const;

export function CleanupView({ rootId }: { rootId: RootId }) {
  const tidy = useEngineQuery("tidy", { rootId });
  const { roots, report } = useEngine();
  const actions = useActions();
  const root = roots.find((candidate) => candidate.id === rootId);
  const data = tidy.data;

  const silent = useEngineQuery("listFiles", {
    ...NO_FILTER,
    rootId,
    kinds: ["video"],
    audioStates: ["silent"],
    ...FIRST_PAGE,
  });

  const junk = useEngineQuery("listFiles", {
    ...NO_FILTER,
    rootId,
    flags: ["junk"],
    ...FIRST_PAGE,
  });

  const folders = useEngineQuery("listEmptyFolders", { rootId });

  const mismatched = useEngineQuery("listFiles", {
    ...NO_FILTER,
    rootId,
    flags: ["extension-mismatch"],
    ...FIRST_PAGE,
  });

  // AVIF and MP4 files under another extension the format accepts, such as .m4v.
  const renamed = useEngineQuery("listFiles", {
    ...NO_FILTER,
    rootId,
    formats: ["avif", "mp4"],
    flags: ["convertible"],
    ...FIRST_PAGE,
  });

  const total = data ? cleanupCount(data) : 0;
  const job = actions.jobFor(SOURCE);

  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Enter" && total > 0 && job === null) {
      void cleanUp();

      return true;
    }

    return false;
  });

  if (!data) {
    return (
      <>
        <TopBar title="Clean up" />
        {tidy.error ? <EmptyState title={tidy.error} /> : <div className="flex-1" />}
      </>
    );
  }

  const { junk: junkCount, emptyFolders, extensions } = data.cleanup;
  const measuring = data.analysis.soundMeasured < data.analysis.soundMeasurable;

  const extensionRows = [
    ...new Map(
      [...(mismatched.data?.rows ?? []), ...(renamed.data?.rows ?? [])].flatMap((row) => {
        const name = row.kind === "junk" ? null : fixedName(row);

        return name === null ? [] : [[row.id, { row, name }] as const];
      }),
    ).values(),
  ];

  const listSilent = async (): Promise<FileId[]> => {
    try {
      return await silentVideoIds(rootId);
    } catch (error) {
      report(error);

      return [];
    }
  };

  const cleanUp = async () => {
    const requests: PlanRequest[] = [];

    if (junkCount + emptyFolders + extensions > 0) {
      requests.push({ kind: "cleanup", rootId });
    }

    if (data.silentTracks.files > 0) {
      const ids = await listSilent();

      if (ids.length > 0) {
        requests.push({ kind: "strip-audio", fileIds: ids });
      }
    }

    const [only] = requests;

    if (requests.length > 1) {
      await actions.performAll(requests.map(planned), {
        title: `Cleaned up ${root?.name ?? "the folder"}`,
        source: SOURCE,
      });
    } else if (only) {
      await actions.perform(only, { source: SOURCE });
    }
  };

  const removeAllSound = async () => {
    const ids = await listSilent();

    if (ids.length > 0) {
      await actions.perform({ kind: "strip-audio", fileIds: ids }, { source: "cleanup:silent" });
    }
  };

  const fixExtensions = async () => {
    let ids: FileId[] = [];

    try {
      ({ ids } = await call("listFileIds", {
        ...NO_FILTER,
        rootId,
        flags: ["extension-mismatch"],
      }));
    } catch (error) {
      report(error);
    }

    // Renames the mismatch fix leaves alone: AVIF and MP4 under an extension their format allows.
    const renames = (renamed.data?.rows ?? []).flatMap((row) => {
      const name = row.extensionMismatch ? null : fixedName(row);

      return name === null ? [] : [{ fileId: row.id, name }];
    });

    const requests: PlanRequest[] = [
      ...(ids.length > 0 ? [{ kind: "fix-extension" as const, fileIds: ids }] : []),
      ...(renames.length > 0 ? [{ kind: "rename" as const, renames }] : []),
    ];

    const [only] = requests;

    if (requests.length > 1) {
      await actions.performAll(requests.map(planned), {
        title: `Fixed ${plural(extensions, "extension")}`,
        source: "cleanup:extensions",
      });
    } else if (only) {
      await actions.perform(only, { source: "cleanup:extensions" });
    }
  };

  return (
    <>
      <TopBar title="Clean up" meta={total > 0 ? plural(total, "item") : null}>
        {job ? (
          <RunProgress job={job} />
        ) : total > 0 ? (
          <button
            type="button"
            className="lw-btn lw-btn-primary lw-btn-lg"
            onClick={() => void cleanUp()}
          >
            Clean up {formatCount(total)} <Kbd>⌘↩</Kbd>
          </button>
        ) : null}
      </TopBar>

      {total === 0 && !job ? (
        <EmptyState icon={Sparkles} title="Nothing to clean up">
          {measuring ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner />
              Still measuring soundtracks · {formatCount(data.analysis.soundMeasured)} of{" "}
              {formatCount(data.analysis.soundMeasurable)}
            </span>
          ) : null}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 pt-6 pb-28">
            <Section
              id="silent"
              title="Silent soundtracks"
              count={data.silentTracks.files}
              action="Remove sound"
              source="cleanup:silent"
              onAction={() => void removeAllSound()}
              shown={silent.data?.rows.length ?? 0}
              more={{ kinds: ["video"], audioStates: ["silent"] }}
            >
              {silent.data?.rows.map((row) => (
                <SilentRow key={row.id} row={row} />
              ))}
            </Section>

            <Section
              id="junk"
              title="Junk files"
              count={junkCount}
              action="Remove"
              source="cleanup:junk"
              onAction={() =>
                void actions.perform({ kind: "clean-junk", rootId }, { source: "cleanup:junk" })
              }
              shown={junk.data?.rows.length ?? 0}
              more={{ flags: ["junk"] }}
            >
              {junk.data?.rows.map((row) => (
                <li
                  key={row.id}
                  className="flex h-11 items-center gap-3 px-4"
                  data-file-name={row.name}
                >
                  <NameAndFolder name={row.name} dir={row.dir} />
                  <span className="lw-caption shrink-0">{formatBytes(row.size)}</span>
                </li>
              ))}
            </Section>

            <Section
              id="folders"
              title="Empty folders"
              count={emptyFolders}
              action="Remove"
              source="cleanup:folders"
              onAction={() =>
                void actions.perform(
                  { kind: "remove-empty-folders", rootId },
                  { source: "cleanup:folders" },
                )
              }
              shown={Math.min(ROW_LIMIT, folders.data?.length ?? 0)}
              more={null}
            >
              {folders.data?.slice(0, ROW_LIMIT).map((folder) => (
                <li key={folder} className="flex h-11 items-center gap-3 px-4">
                  <Folder className="size-4 shrink-0 text-zinc-400" />
                  <StartTruncate text={folder} className="min-w-0 flex-1 text-[13px]" />
                </li>
              ))}
            </Section>

            <Section
              id="extensions"
              title="Wrong extensions"
              count={extensions}
              action="Fix"
              source="cleanup:extensions"
              onAction={() => void fixExtensions()}
              shown={Math.min(ROW_LIMIT, extensionRows.length)}
              more={{ flags: ["extension-mismatch"] }}
            >
              {extensionRows.slice(0, ROW_LIMIT).map(({ row, name }) => (
                <li
                  key={row.id}
                  className="flex h-11 items-center gap-3 px-4"
                  data-file-name={row.name}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]" title={row.relPath}>
                      {row.name} <span className="text-zinc-400">→</span>{" "}
                      <span className="text-amber-700 dark:text-amber-300">{name}</span>
                    </span>
                    {row.dir ? <StartTruncate text={row.dir} className="lw-caption" /> : null}
                  </span>
                </li>
              ))}
            </Section>
          </div>
        </div>
      )}
    </>
  );
}

function NameAndFolder({ name, dir }: { name: string; dir: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px]" title={dir ? `${dir}/${name}` : name}>
        {name}
      </span>
      {dir ? <StartTruncate text={dir} className="lw-caption" /> : null}
    </span>
  );
}

function SilentRow({ row }: { row: FileRow }) {
  const actions = useActions();
  const source = `cleanup:silent:${row.id}`;
  const running = actions.jobFor(source) !== null;

  return (
    <li className="group flex h-14 items-center gap-3 px-4" data-file-name={row.name}>
      <Poster row={row} size={160} className="h-10 w-[72px] shrink-0 rounded-md" />
      <NameAndFolder name={row.name} dir={row.dir} />
      {running ? (
        <Spinner />
      ) : (
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-sm opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
          onClick={() =>
            void actions.perform({ kind: "strip-audio", fileIds: [row.id] }, { source })
          }
        >
          Remove sound
        </button>
      )}
      <span className="lw-caption w-12 shrink-0 text-right">{formatDuration(row.durationMs)}</span>
    </li>
  );
}

function Section({
  id,
  title,
  count,
  action,
  source,
  onAction,
  shown,
  more,
  children,
}: {
  id: string;
  title: string;
  count: number;
  action: string;
  source: string;
  onAction: () => void;
  /** Rows listed, so the footer can say what the list leaves out. */
  shown: number;
  /** The Library filter showing them all, or null when the Library cannot. */
  more: Partial<LibraryPreset> | null;
  children: ReactNode;
}) {
  const actions = useActions();
  const { openLibrary } = useNavigation();
  const running = actions.jobFor(source) !== null;

  if (count === 0) {
    return null;
  }

  return (
    <section className="lw-card" data-section={id}>
      <header className="flex h-12 items-center gap-2 px-4">
        <h2 className="lw-heading">{title}</h2>
        <span className="lw-caption">{formatCount(count)}</span>
        <span className="ml-auto">
          {running ? (
            <Spinner />
          ) : (
            <button type="button" className="lw-btn lw-btn-secondary lw-btn-sm" onClick={onAction}>
              {action}
            </button>
          )}
        </span>
      </header>
      <ul className="divide-y divide-zinc-200/80 border-t lw-divider dark:divide-white/[0.06]">
        {children}
      </ul>
      {count > shown && shown > 0 ? (
        <div className="flex h-11 items-center border-t lw-divider px-4 text-[13px] text-zinc-500 dark:text-zinc-400">
          {more ? (
            <button
              type="button"
              className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:decoration-zinc-600 dark:hover:text-zinc-100"
              onClick={() => openLibrary(more)}
            >
              Show all in Library
            </button>
          ) : (
            `and ${formatCount(count - shown)} more`
          )}
        </div>
      ) : null}
    </section>
  );
}
