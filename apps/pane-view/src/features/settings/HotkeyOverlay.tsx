import { Button } from "@/components/ui/button";
import { GALLERY_HOTKEYS } from "./hotkeys";

interface HotkeyOverlayProps {
  onClose: () => void;
}

export function HotkeyOverlay({ onClose }: HotkeyOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 pr-[max(1rem,var(--safe-area-right))] pb-[max(1rem,var(--safe-area-bottom))] pl-[max(1rem,var(--safe-area-left))] backdrop-blur-sm">
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close keyboard shortcuts"
        onClick={onClose}
      />
      <section className="relative z-10 w-full max-w-lg rounded-xl bg-popover p-5 text-popover-foreground shadow-float">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-balance text-lg font-semibold">Keyboard shortcuts</h2>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
        <ul className="space-y-2">
          {GALLERY_HOTKEYS.map((entry) => (
            <li
              key={entry.action}
              className="flex items-center justify-between gap-4 rounded-lg bg-secondary px-3 py-2 text-sm"
            >
              <span>{entry.action}</span>
              <kbd className="rounded-md bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-surface">
                {entry.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
