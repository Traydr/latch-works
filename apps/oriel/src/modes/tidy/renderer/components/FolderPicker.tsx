import {
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  Film,
  Folder,
  HardDrive,
  House,
  Image,
  Monitor,
} from "lucide-react";
import {
  type ComponentType,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import type { FolderListing, FolderPlace, FolderPlaces } from "../../shared/messages";
import { desktop } from "../lib/api";
import { Kbd, Sheet, StartTruncate } from "./ui";

export interface FolderPickOptions {
  title: string;
  /** The primary button's verb, such as "Choose" or "Move here". */
  action: string;
  /** The folder it opens on; the home folder (or `within`) when absent. */
  start?: string | null;
  /** A folder to highlight once the start folder is listed, such as the current root. */
  select?: string | null;
  /** Keeps the picker inside this folder, which the path field names as `name`. */
  within?: { path: string; name: string } | null;
}

type PickFolder = (options: FolderPickOptions) => Promise<string | null>;

const FolderPickerContext = createContext<PickFolder | null>(null);

/** Opens Glazier's own folder picker; resolves with the chosen folder, or null when cancelled. */
export function useFolderPicker(): PickFolder {
  const pick = useContext(FolderPickerContext);

  if (!pick) {
    throw new Error("useFolderPicker needs a FolderPickerProvider.");
  }

  return pick;
}

export function FolderPickerProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<FolderPickOptions | null>(null);
  const pending = useRef<((folder: string | null) => void) | null>(null);

  const pick = useCallback<PickFolder>((next) => {
    // One picker at a time: ⌘O while it is open does nothing.
    if (pending.current) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      pending.current = resolve;
      setOptions(next);
    });
  }, []);

  const finish = useCallback((folder: string | null) => {
    const resolve = pending.current;

    pending.current = null;
    setOptions(null);
    resolve?.(folder);
  }, []);

  return (
    <FolderPickerContext.Provider value={pick}>
      {children}
      {options ? <FolderPicker options={options} onDone={finish} /> : null}
    </FolderPickerContext.Provider>
  );
}

const PLACE_ICONS: Record<FolderPlace["kind"], ComponentType<{ className?: string }>> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  videos: Film,
  volume: HardDrive,
};

/** How the path field writes a folder: under a short name for home or the root, ending in `/`. */
interface PathNames {
  separator: string;
  prefix: { label: string; path: string } | null;
}

function shown(folder: string, names: PathNames): string {
  const { prefix, separator } = names;
  let text = folder;

  if (prefix && (folder === prefix.path || folder.startsWith(prefix.path + separator))) {
    text = prefix.label + folder.slice(prefix.path.length);
  }

  return text.endsWith(separator) ? text : text + separator;
}

function expanded(text: string, names: PathNames): string {
  const { prefix, separator } = names;

  if (prefix && (text === prefix.label || text.startsWith(prefix.label + separator))) {
    return prefix.path + text.slice(prefix.label.length);
  }

  return text;
}

/** A folder path without its trailing separator, so two spellings of one folder compare equal. */
function trimmed(folder: string, separator: string): string {
  return folder.length > 1 && folder.endsWith(separator) ? folder.slice(0, -1) : folder;
}

function lastName(folder: string, separator: string): string {
  return trimmed(folder, separator).split(separator).at(-1) || folder;
}

/**
 * Glazier's folder picker, in place of the system's: a path field that lists the folders inside
 * what is typed and narrows them as a name is typed, with the usual places and drives beside it.
 * ↑ ↓ highlight a folder, ↩ or Tab opens it, ↩ on nothing highlighted (or ⌘↩) chooses.
 */
function FolderPicker({
  options,
  onDone,
}: {
  options: FolderPickOptions;
  onDone: (folder: string | null) => void;
}) {
  const [places, setPlaces] = useState<FolderPlaces | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState("");
  const [highlight, setHighlight] = useState<number | null>(null);
  const request = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const within = options.within ?? null;

  useEffect(() => {
    void desktop
      .folderPlaces()
      .then(setPlaces, () => setPlaces({ home: "/", separator: "/", places: [], volumes: [] }));
  }, []);

  const separator = places?.separator ?? "/";

  const names: PathNames = {
    separator,
    prefix: within
      ? { label: within.name, path: within.path }
      : places && separator === "/"
        ? { label: "~", path: places.home }
        : null,
  };

  const isInside = (folder: string) =>
    within === null || folder === within.path || folder.startsWith(within.path + separator);

  const latestNames = useRef(names);

  latestNames.current = names;

  /** Lists `folder`; `retype` writes it into the path field, as a click or Enter does. */
  const open = useCallback(async (folder: string, retype: boolean, select?: string | null) => {
    request.current += 1;

    const id = request.current;
    const next = await desktop.listFolder(folder);

    if (id !== request.current) {
      return;
    }

    setListing(next);

    const selected =
      next.ok && select ? next.folders.findIndex((entry) => entry.path === select) : -1;

    setHighlight(selected >= 0 ? selected : null);

    if (retype) {
      setTyped(shown(next.path, latestNames.current));
    }
  }, []);

  // The first listing waits for the platform's separator and home folder.
  const started = useRef(false);

  useEffect(() => {
    if (places && !started.current) {
      started.current = true;
      void open(options.start ?? within?.path ?? places.home, true, options.select);
    }
  }, [places, open, options.start, options.select, within]);

  const cut = Math.max(typed.lastIndexOf("/"), separator === "\\" ? typed.lastIndexOf("\\") : -1);
  const typedFolder = typed.slice(0, cut + 1);
  const query = typed.slice(cut + 1).toLowerCase();
  const wanted = typedFolder === "" ? null : trimmed(expanded(typedFolder, names), separator);
  const current = listing ? trimmed(listing.path, separator) : null;
  const outside = wanted !== null && !isInside(wanted);
  // The field names a folder that is not listed yet: list it once the typing pauses.
  const behind = wanted !== null && wanted !== current;

  useEffect(() => {
    if (!behind || outside || wanted === null) {
      return;
    }

    const timer = window.setTimeout(() => void open(wanted, false), 120);

    return () => window.clearTimeout(timer);
  }, [behind, outside, wanted, open]);

  const folders = listing?.ok ? listing.folders : [];

  const matches =
    query === ""
      ? folders
      : [
          ...folders.filter((entry) => entry.name.toLowerCase().startsWith(query)),
          ...folders.filter(
            (entry) =>
              !entry.name.toLowerCase().startsWith(query) &&
              entry.name.toLowerCase().includes(query),
          ),
        ];

  // Typing a name highlights the best match, so ↩ goes into it.
  const active =
    highlight !== null && highlight < matches.length
      ? highlight
      : query !== "" && matches.length > 0
        ? 0
        : null;

  const target = active === null ? null : (matches[active] ?? null);
  const ready = listing?.ok === true && !behind && !outside;
  const chosen = target?.path ?? (ready && listing ? listing.path : null);

  const atTop =
    listing === null || listing.parent === null || (within !== null && current === within.path);

  useEffect(() => {
    if (active !== null) {
      list.current?.children[active]?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const choose = () => {
    if (chosen !== null && isInside(chosen)) {
      onDone(chosen);
    }
  };

  const goUp = () => {
    if (!atTop && listing?.parent) {
      void open(listing.parent, true, listing.path);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      choose();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "ArrowUp") {
      event.preventDefault();
      goUp();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      if (matches.length > 0) {
        const from = active ?? -1;
        const step = event.key === "ArrowDown" ? 1 : -1;

        setHighlight(Math.max(0, Math.min(matches.length - 1, from + step)));
      }
    } else if ((event.key === "Tab" && !event.shiftKey) || event.key === "Enter") {
      if (target) {
        event.preventDefault();
        void open(target.path, true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose();
      }
    }
  };

  const chosenName =
    chosen === null
      ? null
      : within && trimmed(chosen, separator) === within.path
        ? within.name
        : lastName(chosen, separator);

  const placeList = within ? null : (
    <nav aria-label="Places" className="w-44 shrink-0 space-y-0.5 overflow-y-auto pr-3">
      {[
        { label: "Places", items: places?.places ?? [] },
        { label: "Drives", items: places?.volumes ?? [] },
      ].map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.label} className="pb-3">
            <p className="px-2.5 pb-1.5 text-xs font-medium text-zinc-500">{group.label}</p>
            {group.items.map((place) => {
              const Icon = PLACE_ICONS[place.kind];
              const here = current === trimmed(place.path, separator);

              return (
                <button
                  key={`${place.kind}:${place.path}`}
                  type="button"
                  title={place.path}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void open(place.path, true)}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${
                    here ? "gz-selected" : "gz-hover"
                  }`}
                >
                  <Icon className="size-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                  <span className="truncate">{place.label}</span>
                </button>
              );
            })}
          </div>
        ),
      )}
    </nav>
  );

  const empty =
    listing === null ? null : !listing.ok ? (
      <span className="inline-flex items-center gap-2">
        <CircleAlert className="size-4 text-amber-500" />
        {listing.message}
      </span>
    ) : folders.length === 0 ? (
      "No folders inside"
    ) : matches.length === 0 ? (
      `No folder named “${typed.slice(cut + 1)}”`
    ) : null;

  return (
    <Sheet
      title={options.title}
      onClose={() => onDone(null)}
      width={within ? 560 : 760}
      footer={
        <>
          <span className="gz-caption mr-auto min-w-0 flex-1">
            {chosen !== null ? <StartTruncate text={chosen} /> : null}
          </span>
          <button type="button" className="gz-btn gz-btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="gz-btn gz-btn-primary"
            disabled={chosen === null}
            title={`${options.action}  ⌘↩`}
            data-folder-choose
            onClick={choose}
          >
            <span className="max-w-56 truncate">
              {options.action}
              {chosenName ? ` “${chosenName}”` : ""}
            </span>
            <Kbd>⌘↩</Kbd>
          </button>
        </>
      }
    >
      <div className="flex h-[400px] min-h-0">
        {placeList}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="gz-btn gz-btn-secondary gz-btn-icon shrink-0"
              title="Enclosing folder  ⌘↑"
              aria-label="Enclosing folder"
              disabled={atTop}
              onMouseDown={(event) => event.preventDefault()}
              onClick={goUp}
            >
              <ArrowUp />
            </button>
            <input
              data-autofocus
              aria-label="Folder path"
              data-folder-path
              className="gz-input h-8"
              spellCheck={false}
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setHighlight(null);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {outside && within ? (
            <p className="gz-caption px-1 text-amber-700 dark:text-amber-300">
              Choose a folder inside {within.name}.
            </p>
          ) : null}
          <div className="gz-card min-h-0 flex-1 overflow-y-auto p-1">
            {empty ? (
              <div className="gz-caption flex h-full items-center justify-center p-6 text-center">
                {empty}
              </div>
            ) : (
              <ul ref={list} aria-label="Folders">
                {matches.map((entry, index) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      data-folder-name={entry.name}
                      aria-current={index === active}
                      title={`${entry.path}\nDouble-click or ↩ to open`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setHighlight(index)}
                      onDoubleClick={() => void open(entry.path, true)}
                      className={`group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ${
                        index === active ? "gz-selected" : "gz-hover"
                      }`}
                    >
                      <Folder className="size-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRight
                        className={`size-3.5 shrink-0 text-zinc-400 ${
                          index === active ? "" : "opacity-0 group-hover:opacity-100"
                        }`}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
