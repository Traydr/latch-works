import type { LockstepPlanItem } from "../../shared/types";

export interface PlanFile {
  action: LockstepPlanItem["action"];
  name: string;
  path: string;
  size: number | undefined;
}

export interface PlanFolder {
  /** Shown name; a chain of folders holding only one folder each collapses into "a/b/c". */
  label: string;
  path: string;
  folders: PlanFolder[];
  files: PlanFile[];
  /** Bytes to push and items in this folder and every folder below it. */
  size: number;
  itemCount: number;
}

export type PlanTreeRow =
  | { type: "folder"; depth: number; folder: PlanFolder; open: boolean }
  | { type: "file"; depth: number; file: PlanFile }
  | { type: "more"; depth: number; folder: PlanFolder; hidden: number };

/** Files listed per open folder before a "show more" row; a first push can hold thousands. */
const FILES_PER_FOLDER = 200;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface FolderDraft {
  folders: Map<string, FolderDraft>;
  files: PlanFile[];
  name: string;
  path: string;
}

/** Groups plan items into their folders, sorted the way a file browser lists them. */
export function buildPlanTree(items: readonly LockstepPlanItem[]): PlanFolder {
  const root: FolderDraft = { folders: new Map(), files: [], name: "", path: "" };

  for (const item of items) {
    const segments = item.path.split("/");
    const name = segments.pop() ?? item.path;
    let folder = root;

    for (const segment of segments) {
      let child = folder.folders.get(segment);

      if (!child) {
        const path = folder.path ? `${folder.path}/${segment}` : segment;
        child = { folders: new Map(), files: [], name: segment, path };
        folder.folders.set(segment, child);
      }

      folder = child;
    }

    // A delete moves no bytes; its size is the remote copy's.
    const size = item.action === "delete" ? undefined : item.size;
    folder.files.push({ action: item.action, name, path: item.path, size });
  }

  return finishFolder(root);
}

function finishFolder(draft: FolderDraft): PlanFolder {
  const folders = [...draft.folders.values()]
    .map((child) => collapseChain(finishFolder(child)))
    .sort((a, b) => collator.compare(a.label, b.label));

  const files = draft.files.sort((a, b) => collator.compare(a.name, b.name));
  let size = 0;
  let itemCount = files.length;

  for (const file of files) {
    size += file.size ?? 0;
  }

  for (const folder of folders) {
    size += folder.size;
    itemCount += folder.itemCount;
  }

  return { files, folders, itemCount, label: draft.name, path: draft.path, size };
}

function collapseChain(folder: PlanFolder): PlanFolder {
  const [only, ...rest] = folder.folders;

  if (folder.files.length > 0 || !only || rest.length > 0) {
    return folder;
  }

  return { ...only, label: `${folder.label}/${only.label}` };
}

/**
 * The rows an expanded tree shows, top to bottom. `isOpen` decides each folder; open folders list
 * at most a page of files unless their path is in `showAllFiles`.
 */
export function flattenPlanTree({
  isOpen,
  root,
  showAllFiles,
}: {
  isOpen: (folder: PlanFolder) => boolean;
  root: PlanFolder;
  showAllFiles: ReadonlySet<string>;
}): PlanTreeRow[] {
  const rows: PlanTreeRow[] = [];

  const visit = (folder: PlanFolder, depth: number): void => {
    for (const child of folder.folders) {
      const open = isOpen(child);
      rows.push({ type: "folder", depth, folder: child, open });

      if (open) {
        visit(child, depth + 1);
      }
    }

    const limit = showAllFiles.has(folder.path) ? folder.files.length : FILES_PER_FOLDER;

    for (const file of folder.files.slice(0, limit)) {
      rows.push({ type: "file", depth, file });
    }

    if (folder.files.length > limit) {
      rows.push({ type: "more", depth, folder, hidden: folder.files.length - limit });
    }
  };

  visit(root, 0);

  return rows;
}

/** Every file path in `folder` and below it. */
export function* folderPaths(folder: PlanFolder): Generator<string> {
  for (const file of folder.files) {
    yield file.path;
  }

  for (const child of folder.folders) {
    yield* folderPaths(child);
  }
}
