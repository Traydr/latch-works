import { Kbd, Modal } from "./ui";

const GROUPS = [
  {
    title: "Everywhere",
    keys: [
      ["⌘1 – ⌘4", "Tidy, Duplicates, Library, History"],
      ["⌘O", "Add a folder"],
      ["⌘R", "Rescan the folder"],
      ["⌘Z", "Undo the last change"],
      ["⌘,", "Settings"],
      ["?", "This list"],
    ],
  },
  {
    title: "Duplicates",
    keys: [
      ["↑ ↓  or  J K", "Previous or next set"],
      ["← →  or  Q E", "Focus a version"],
      ["1 – 9", "Keep only that version"],
      ["⇧1 – ⇧9", "Also keep that version"],
      ["↩", "Resolve and go to the next set"],
      ["⌘↩", "Resolve every remaining set"],
      ["S", "Skip this set"],
      ["N", "Not duplicates"],
      ["P", "Prefer the focused version's folder"],
      ["Space", "Quick Look, or play and pause videos"],
      ["Z", "Compare at 100%"],
      ["M", "Hear the kept video"],
    ],
  },
  {
    title: "Library",
    keys: [
      ["↑ ↓", "Move, ⇧ to extend the selection"],
      ["⌘A", "Select every matching file"],
      ["Space", "Quick Look"],
      ["↩", "Rename"],
      ["⌘⌫", "Move to holding"],
      ["⇧⌘M", "Move to…"],
      ["⇧⌘R", "Show in Finder"],
      ["/  or  ⌘F", "Search"],
      ["Esc", "Clear the selection"],
    ],
  },
] as const;

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={640}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map((group) => (
          <section key={group.title} className={group.title === "Duplicates" ? "row-span-2" : ""}>
            <h3 className="ls-label mb-1.5">{group.title}</h3>
            <dl className="space-y-1">
              {group.keys.map(([keys, action]) => (
                <div key={keys} className="flex items-baseline justify-between gap-4">
                  <dt className="text-zinc-600 dark:text-zinc-300">{action}</dt>
                  <dd className="shrink-0">
                    <Kbd>{keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
