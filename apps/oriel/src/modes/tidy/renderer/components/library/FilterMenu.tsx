import {
  AudioStateSchema,
  type FileFacets,
  FileKindSchema,
} from "@latch-works/glazier-core/contract";
import { ListFilter, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { formatCount, formatLabel } from "../../lib/format";
import type { LibraryPreset } from "../../lib/navigation";
import { Menu, MenuCheck, MenuLabel, MenuSeparator, StartTruncate } from "../ui";
import { AUDIO_LABELS, FLAG_LABELS, ISSUE_FLAGS, KIND_LABELS } from "./labels";

/** The Library's filters: everything in a preset except the search, which has its own field. */
export type Filters = Omit<LibraryPreset, "search">;

export function activeFilterCount(filters: Filters): number {
  return (
    filters.kinds.length +
    filters.formats.length +
    filters.audioStates.length +
    filters.flags.length +
    (filters.dir === null ? 0 : 1)
  );
}

function toggled<T>(values: readonly T[], value: T, on: boolean): T[] {
  const without = values.filter((entry) => entry !== value);

  return on ? [...without, value] : without;
}

/** Folders listed at once; the field narrows the rest. */
const FOLDER_LIMIT = 200;

/**
 * One Filter button for Kind, Format, Sound, Issues and Folder. Values that would match nothing
 * stay out of the menu unless they are already chosen.
 */
export function FilterMenu({
  filters,
  facets,
  folders,
  rootName,
  onChange,
}: {
  filters: Filters;
  facets: FileFacets | null;
  folders: readonly string[];
  rootName: string;
  onChange: (next: Partial<Filters>) => void;
}) {
  const [folderSearch, setFolderSearch] = useState("");
  const active = activeFilterCount(filters);

  const countOf = <T,>(list: ReadonlyArray<{ value: T; files: number }> | undefined, value: T) =>
    list?.find((entry) => entry.value === value)?.files ?? 0;

  const kinds = FileKindSchema.options.flatMap((kind) => {
    const files = countOf(facets?.kinds, kind);
    const checked = filters.kinds.includes(kind);

    return files > 0 || checked
      ? [
          <MenuCheck
            key={kind}
            label={KIND_LABELS[kind]}
            count={formatCount(files)}
            checked={checked}
            onChange={(on) => onChange({ kinds: toggled(filters.kinds, kind, on) })}
          />,
        ]
      : [];
  });

  const formats = [
    ...(facets?.formats ?? []).flatMap((entry) =>
      entry.value === null ? [] : [{ value: entry.value, files: entry.files }],
    ),
    ...filters.formats.flatMap((format) =>
      facets?.formats.some((entry) => entry.value === format) ? [] : [{ value: format, files: 0 }],
    ),
  ].map(({ value, files }) => (
    <MenuCheck
      key={value}
      label={formatLabel(value)}
      count={formatCount(files)}
      checked={filters.formats.includes(value)}
      onChange={(on) => onChange({ formats: toggled(filters.formats, value, on) })}
    />
  ));

  const sounds = AudioStateSchema.options.flatMap((state) => {
    const files = countOf(facets?.audioStates, state);
    const checked = filters.audioStates.includes(state);

    return files > 0 || checked
      ? [
          <MenuCheck
            key={state}
            label={AUDIO_LABELS[state]}
            count={formatCount(files)}
            checked={checked}
            onChange={(on) => onChange({ audioStates: toggled(filters.audioStates, state, on) })}
          />,
        ]
      : [];
  });

  const issues = ISSUE_FLAGS.flatMap((flag) => {
    const files = countOf(facets?.flags, flag);
    const checked = filters.flags.includes(flag);

    return files > 0 || checked
      ? [
          <MenuCheck
            key={flag}
            label={FLAG_LABELS[flag]}
            count={formatCount(files)}
            checked={checked}
            onChange={(on) => onChange({ flags: toggled(filters.flags, flag, on) })}
          />,
        ]
      : [];
  });

  const needle = folderSearch.trim().toLowerCase();

  const folderMatches = folders
    .filter((folder) => folder !== "" && folder.toLowerCase().includes(needle))
    .slice(0, FOLDER_LIMIT);

  return (
    <Menu
      label={
        <>
          <ListFilter />
          Filter
          {active > 0 ? <span className="text-zinc-500">{formatCount(active)}</span> : null}
        </>
      }
      title="Filter"
    >
      {(close) => (
        <div className="max-h-[min(640px,calc(100vh-120px))] w-[520px] overflow-y-auto">
          <div className="grid grid-cols-2 gap-x-1">
            <div>
              <Group label="Kind">{kinds}</Group>
              <Group label="Sound">{sounds}</Group>
            </div>
            <div>
              <Group label="Format">{formats}</Group>
              <Group label="Issues">{issues}</Group>
            </div>
          </div>
          <MenuSeparator />
          <MenuLabel>Folder</MenuLabel>
          {folders.length > 8 ? (
            <div className="px-1 pb-1">
              <input
                className="gz-input"
                placeholder="Find a folder"
                aria-label="Find a folder"
                value={folderSearch}
                onChange={(event) => setFolderSearch(event.target.value)}
              />
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto">
            <MenuCheck
              label={`All of ${rootName}`}
              checked={filters.dir === null}
              onChange={() => {
                onChange({ dir: null });
                close();
              }}
            />
            {folderMatches.map((folder) => (
              <MenuCheck
                key={folder}
                label={<StartTruncate text={folder} />}
                checked={filters.dir === folder}
                onChange={(on) => {
                  onChange({ dir: on ? folder : null });
                  close();
                }}
              />
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}

function Group({ label, children }: { label: string; children: ReactNode[] }) {
  if (children.length === 0) {
    return null;
  }

  return (
    <div className="pb-1">
      <MenuLabel>{label}</MenuLabel>
      {children}
    </div>
  );
}

/** The 40 px row of active filters under the top bar, each removable; hidden when none are on. */
export function FilterChips({
  filters,
  rootName,
  onChange,
  onClear,
}: {
  filters: Filters;
  rootName: string;
  onChange: (next: Partial<Filters>) => void;
  onClear: () => void;
}) {
  if (activeFilterCount(filters) === 0) {
    return null;
  }

  const chips = [
    ...filters.kinds.map((kind) => ({
      key: `kind:${kind}`,
      label: KIND_LABELS[kind],
      remove: () => onChange({ kinds: filters.kinds.filter((entry) => entry !== kind) }),
    })),
    ...filters.formats.map((format) => ({
      key: `format:${format}`,
      label: formatLabel(format),
      remove: () => onChange({ formats: filters.formats.filter((entry) => entry !== format) }),
    })),
    ...filters.audioStates.map((state) => ({
      key: `sound:${state}`,
      label: AUDIO_LABELS[state],
      remove: () =>
        onChange({ audioStates: filters.audioStates.filter((entry) => entry !== state) }),
    })),
    ...filters.flags.map((flag) => ({
      key: `flag:${flag}`,
      label: FLAG_LABELS[flag],
      remove: () => onChange({ flags: filters.flags.filter((entry) => entry !== flag) }),
    })),
    ...(filters.dir === null
      ? []
      : [
          {
            key: "dir",
            label: `In ${filters.dir || rootName}`,
            remove: () => onChange({ dir: null }),
          },
        ]),
  ];

  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b gz-divider px-5">
      {chips.map((chip) => (
        <span key={chip.key} className="gz-chip max-w-72 shrink-0">
          <span className="truncate" title={chip.label}>
            {chip.label}
          </span>
          <button
            type="button"
            aria-label={`Remove ${chip.label}`}
            onClick={chip.remove}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-900/10 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button type="button" className="gz-btn gz-btn-ghost gz-btn-sm shrink-0" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
