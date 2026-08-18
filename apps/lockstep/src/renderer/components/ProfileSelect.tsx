import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ProfileSelectProps {
  onChange: (profileId: string) => void;
  profiles: Array<{ id: string; name: string }>;
  value: string;
}

export function ProfileSelect({ onChange, profiles, value }: ProfileSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeProfile = profiles.find((profile) => profile.id === value);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Active profile"
        className="prism-btn inline-flex h-8 min-w-[10rem] max-w-[12rem] items-center justify-between gap-2"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{activeProfile?.name ?? "Select profile"}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </button>

      {open ? (
        <div
          className="absolute top-full right-0 z-50 mt-1 max-h-60 min-w-full overflow-auto rounded-xl border border-zinc-300/90 bg-white/95 p-1 shadow-xl backdrop-blur-xl dark:border-zinc-600/90 dark:bg-zinc-900/95"
          role="listbox"
        >
          {profiles.map((profile) => {
            const selected = profile.id === value;

            return (
              <button
                key={profile.id}
                aria-selected={selected}
                className={`w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs ${
                  selected
                    ? "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-100"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                }`}
                role="option"
                type="button"
                onClick={() => {
                  onChange(profile.id);
                  setOpen(false);
                }}
              >
                {profile.name}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
