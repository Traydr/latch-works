import { GALLERY_HOTKEYS } from "./hotkeys";

interface HotkeyOverlayProps {
  onClose: () => void;
}

export function HotkeyOverlay({ onClose }: HotkeyOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
      />
      <section className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <ul className="space-y-2">
          {GALLERY_HOTKEYS.map((entry) => (
            <li
              key={entry.action}
              className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2 text-sm"
            >
              <span>{entry.action}</span>
              <kbd className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{entry.keys}</kbd>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
