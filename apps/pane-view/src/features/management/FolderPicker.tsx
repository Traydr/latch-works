import type { FolderNode } from "@latch-works/media-domain";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";

interface FolderPickerProps {
  folders: FolderNode[];
  onChange: (paths: string[]) => void;
  selectedPaths: string[];
}

export function FolderPicker({ folders, onChange, selectedPaths }: FolderPickerProps) {
  const [query, setQuery] = useState("");

  const visibleFolders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter(
      (folder) =>
        folder.path.toLowerCase().includes(normalizedQuery) ||
        folder.name.toLowerCase().includes(normalizedQuery),
    );
  }, [folders, query]);

  const togglePath = (path: string) => {
    if (selectedPaths.includes(path)) {
      onChange(selectedPaths.filter((value) => value !== path));
      return;
    }

    onChange([...selectedPaths, path]);
  };

  return (
    <div className="space-y-3">
      <Input
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search folders"
        value={query}
      />

      <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
        {visibleFolders.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No folders match this search.</p>
        ) : (
          <ul className="divide-y divide-border">
            {visibleFolders.map((folder) => {
              const checked = selectedPaths.includes(folder.path);
              return (
                <li key={folder.path}>
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                    <input
                      checked={checked}
                      className="mt-1"
                      onChange={() => togglePath(folder.path)}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{folder.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {folder.path}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
