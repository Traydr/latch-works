import { Kbd, Sheet } from "./ui";

/** An action, its one key (keycaps split on spaces), and an optional mouse alternative. */
type Shortcut = readonly [action: string, keys: string, note?: string];

type Group = { title: string; rows: readonly Shortcut[] };

const EVERYWHERE: Group = {
  title: "Everywhere",
  rows: [
    ["Overview", "⌘1"],
    ["Duplicates", "⌘2"],
    ["Convert", "⌘3"],
    ["Clean up", "⌘4"],
    ["Library", "⌘5"],
    ["History", "⌘6"],
    ["Holding", "⌘7"],
    ["Settings", "⌘,"],
    ["Add folder", "⌘O"],
    ["Rescan", "⌘R"],
    ["Find", "⌘F"],
    ["Undo", "⌘Z"],
    ["Run the page's main action", "⌘↩"],
    ["Collapse the sidebar", "⌘\\"],
    ["Shortcuts", "?"],
  ],
};

const OVERVIEW: Group = {
  title: "Overview",
  rows: [
    ["Move between rows", "↑ ↓"],
    ["Open a row", "↩"],
  ],
};

const DUPLICATES: Group = {
  title: "Duplicates",
  rows: [
    ["Keep the suggestion and go on", "↩"],
    ["Keep only this one", "1–9", "(or click)"],
    ["Keep this one as well", "⇧1–9", "(or ⇧-click, or its checkbox)"],
    ["Keep both (not duplicates)", "N"],
    ["Skip", "S"],
    ["Previous", "K"],
    ["Move between versions", "← →"],
    ["Look closer", "Space"],
    ["Flip versions", "← →"],
    ["Keep the one shown", "↩"],
    ["Actual size", "Z"],
    ["Quick Look", "⌘Y"],
    ["Show in Finder", "⇧⌘R"],
    ["Sound on or off", "M"],
    ["Prefer this folder", "P"],
    ["Keep every similar suggestion", "⌘↩"],
  ],
};

const LIBRARY: Group = {
  title: "Library",
  rows: [
    ["Search", "/"],
    ["Move", "↑ ↓"],
    ["Extend", "⇧↑ ⇧↓"],
    ["Quick Look", "Space"],
    ["Rename", "↩"],
    ["Select all", "⌘A"],
    ["Move to holding", "⌘⌫"],
    ["Move to…", "⇧⌘M"],
    ["Show in Finder", "⇧⌘R"],
    ["Inspector", "I"],
    ["Clear selection", "Esc"],
  ],
};

const HOLDING: Group = {
  title: "Holding",
  rows: [
    ["Restore", "⌘⌫"],
    ["Empty to Trash", "⇧⌘⌫"],
    ["Select all", "⌘A"],
  ],
};

const HISTORY: Group = {
  title: "History",
  rows: [
    ["Move", "↑ ↓"],
    ["Expand and collapse", "→ ←"],
    ["Undo", "U"],
  ],
};

const SHEET_WIDTH = 1120;

/** Three columns at every window size (Glazier is never under 960 px wide), so it never scrolls. */
const COLUMNS: ReadonlyArray<readonly Group[]> = [
  [EVERYWHERE, OVERVIEW],
  [DUPLICATES],
  [LIBRARY, HOLDING, HISTORY],
];

function Keys({ keys }: { keys: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.split(" ").map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

/** Rows are 24 px so the sheet fits a 700 px window without scrolling. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keyboard shortcuts" onClose={onClose} width={SHEET_WIDTH}>
      <div className="grid grid-cols-3 gap-x-8">
        {COLUMNS.map((column) => (
          <div key={column[0]?.title} className="space-y-3">
            {column.map((group) => (
              <section key={group.title}>
                <h3 className="mb-0.5 text-xs font-medium text-zinc-500">{group.title}</h3>
                <dl>
                  {group.rows.map(([action, keys, note]) => (
                    <div
                      key={action}
                      className="flex h-6 items-center justify-between gap-4 text-[13px]"
                    >
                      <dt className="min-w-0 truncate">
                        {action}
                        {note ? <span className="text-zinc-500"> {note}</span> : null}
                      </dt>
                      <dd>
                        <Keys keys={keys} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
