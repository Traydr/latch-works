import type { FileRow } from "@latch-works/glazier-core/contract";
import { useEffect, useRef, useState } from "react";

/** The name, editable in place: Return renames, Esc or clicking away keeps it. */
export function RenameField({
  row,
  onDone,
  className = "",
}: {
  row: FileRow;
  onDone: (name: string | null) => void;
  className?: string;
}) {
  const [name, setName] = useState(row.name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    const element = input.current;

    if (element) {
      element.focus();

      const dot = row.name.lastIndexOf(".");

      element.setSelectionRange(0, dot > 0 ? dot : row.name.length);
    }
  }, [row.name]);

  const finish = (value: string | null) => {
    if (!finished.current) {
      finished.current = true;
      onDone(value);
    }
  };

  return (
    <input
      ref={input}
      aria-label={`New name for ${row.name}`}
      className={`lw-input h-6 rounded-md px-1.5 ${className}`}
      value={name}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => finish(null)}
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === "Enter") {
          finish(name.trim() && name.trim() !== row.name ? name.trim() : null);
        } else if (event.key === "Escape") {
          finish(null);
        }
      }}
    />
  );
}
