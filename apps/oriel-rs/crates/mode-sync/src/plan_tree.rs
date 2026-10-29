//! The plan as a tree of folders, from Electron Oriel's `plan-tree.ts`: each change under its
//! folders, sorted as a file browser lists them, a chain of single folders collapsed into one
//! row (`a/b/c`), and rows flattened for the list with a "show more" row after a page of files.

use std::collections::{HashMap, HashSet};

use oriel_core_domain::{NamedPath, compare_by_name};
use oriel_core_index::SyncPlanAction;

/// Files listed per open folder before a "show more" row; a first push can hold thousands.
pub const FILES_PER_FOLDER: usize = 200;

/// Plans up to this size open every folder; larger ones open only small folders.
pub const OPEN_ALL_LIMIT: usize = 300;
pub const OPEN_FOLDER_LIMIT: usize = 40;

/// One change as the tree holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanFile {
    pub action: SyncPlanAction,
    pub name: String,
    pub path: String,
    /// The bytes it moves; a delete moves none.
    pub size: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanFolder {
    /// Shown name; a chain of folders holding one folder each reads `a/b/c`.
    pub label: String,
    pub path: String,
    pub folders: Vec<PlanFolder>,
    pub files: Vec<PlanFile>,
    /// Bytes and items in this folder and every folder below it.
    pub size: u64,
    pub item_count: usize,
}

/// One row of the flattened tree.
#[derive(Clone, Debug, PartialEq)]
pub enum PlanRow<'a> {
    Folder {
        depth: usize,
        folder: &'a PlanFolder,
        open: bool,
    },
    File {
        depth: usize,
        file: &'a PlanFile,
    },
    More {
        depth: usize,
        folder: &'a PlanFolder,
        hidden: usize,
    },
}

/// An item to put in the tree: its action, path and size.
pub struct TreeInput<'a> {
    pub action: SyncPlanAction,
    pub path: &'a str,
    pub size: Option<u64>,
}

struct Label<'a>(&'a str);

impl NamedPath for Label<'_> {
    fn name(&self) -> &str {
        self.0
    }

    fn path(&self) -> &str {
        self.0
    }
}

/// `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    compare_by_name(&Label(a), &Label(b))
}

#[derive(Default)]
struct Draft {
    order: Vec<String>,
    folders: HashMap<String, Draft>,
    files: Vec<PlanFile>,
    name: String,
    path: String,
}

/// `buildPlanTree`.
pub fn build_plan_tree<'a>(items: impl IntoIterator<Item = TreeInput<'a>>) -> PlanFolder {
    let mut root = Draft::default();
    for item in items {
        let mut segments: Vec<&str> = item.path.split('/').collect();
        let name = segments.pop().unwrap_or(item.path).to_owned();
        let mut folder = &mut root;
        for segment in segments {
            if !folder.folders.contains_key(segment) {
                let path = if folder.path.is_empty() {
                    segment.to_owned()
                } else {
                    format!("{}/{segment}", folder.path)
                };
                folder.order.push(segment.to_owned());
                folder.folders.insert(
                    segment.to_owned(),
                    Draft {
                        name: segment.to_owned(),
                        path,
                        ..Draft::default()
                    },
                );
            }
            folder = folder
                .folders
                .get_mut(segment)
                .expect("the folder was just added");
        }
        folder.files.push(PlanFile {
            action: item.action,
            name,
            path: item.path.to_owned(),
            size: if item.action == SyncPlanAction::Delete {
                None
            } else {
                item.size
            },
        });
    }
    finish(root)
}

fn finish(mut draft: Draft) -> PlanFolder {
    let mut folders: Vec<PlanFolder> = draft
        .order
        .iter()
        .filter_map(|name| draft.folders.remove(name))
        .map(|child| collapse_chain(finish(child)))
        .collect();
    folders.sort_by(|a, b| natural(&a.label, &b.label));
    let mut files = draft.files;
    files.sort_by(|a, b| natural(&a.name, &b.name));
    let size = files.iter().filter_map(|file| file.size).sum::<u64>()
        + folders.iter().map(|folder| folder.size).sum::<u64>();
    let item_count = files.len()
        + folders
            .iter()
            .map(|folder| folder.item_count)
            .sum::<usize>();
    PlanFolder {
        label: draft.name,
        path: draft.path,
        folders,
        files,
        size,
        item_count,
    }
}

fn collapse_chain(folder: PlanFolder) -> PlanFolder {
    if !folder.files.is_empty() || folder.folders.len() != 1 {
        return folder;
    }
    let label = folder.label;
    let only = folder
        .folders
        .into_iter()
        .next()
        .expect("one folder, checked above");
    PlanFolder {
        label: format!("{label}/{}", only.label),
        ..only
    }
}

/// `flattenPlanTree`: the rows top to bottom. `open_overrides` holds folders the user opened or
/// closed; the rest open by size.
pub fn flatten_plan_tree<'a>(
    root: &'a PlanFolder,
    open_overrides: &HashMap<String, bool>,
    show_all_files: &HashSet<String>,
) -> Vec<PlanRow<'a>> {
    let open_all = root.item_count <= OPEN_ALL_LIMIT;
    let mut rows = Vec::new();
    visit(root, 0, open_all, open_overrides, show_all_files, &mut rows);
    rows
}

fn visit<'a>(
    folder: &'a PlanFolder,
    depth: usize,
    open_all: bool,
    open_overrides: &HashMap<String, bool>,
    show_all_files: &HashSet<String>,
    rows: &mut Vec<PlanRow<'a>>,
) {
    for child in &folder.folders {
        let open = open_overrides
            .get(&child.path)
            .copied()
            .unwrap_or(open_all || child.item_count <= OPEN_FOLDER_LIMIT);
        rows.push(PlanRow::Folder {
            depth,
            folder: child,
            open,
        });
        if open {
            visit(
                child,
                depth + 1,
                open_all,
                open_overrides,
                show_all_files,
                rows,
            );
        }
    }
    let limit = if show_all_files.contains(&folder.path) {
        folder.files.len()
    } else {
        FILES_PER_FOLDER
    };
    for file in folder.files.iter().take(limit) {
        rows.push(PlanRow::File { depth, file });
    }
    if folder.files.len() > limit {
        rows.push(PlanRow::More {
            depth,
            folder,
            hidden: folder.files.len() - limit,
        });
    }
}

/// Every file path in `folder` and below it.
pub fn folder_paths(folder: &PlanFolder) -> Vec<&str> {
    let mut paths: Vec<&str> = folder.files.iter().map(|file| file.path.as_str()).collect();
    for child in &folder.folders {
        paths.extend(folder_paths(child));
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(action: SyncPlanAction, path: &str, size: u64) -> TreeInput<'_> {
        TreeInput {
            action,
            path,
            size: Some(size),
        }
    }

    #[test]
    fn groups_changes_into_sorted_folders_and_collapses_chains() {
        let tree = build_plan_tree([
            input(SyncPlanAction::Upload, "b/10.jpg", 10),
            input(SyncPlanAction::Upload, "b/2.jpg", 2),
            input(SyncPlanAction::Delete, "a/x/y/gone.jpg", 99),
            input(SyncPlanAction::Update, "top.png", 5),
        ]);
        assert_eq!(tree.item_count, 4);
        assert_eq!(tree.size, 17, "a delete moves no bytes");
        let labels: Vec<&str> = tree.folders.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, ["a/x/y", "b"]);
        let names: Vec<&str> = tree.folders[1]
            .files
            .iter()
            .map(|f| f.name.as_str())
            .collect();
        assert_eq!(names, ["2.jpg", "10.jpg"], "natural order");

        let rows = flatten_plan_tree(&tree, &HashMap::new(), &HashSet::new());
        assert_eq!(rows.len(), 6);
        assert!(matches!(
            rows[0],
            PlanRow::Folder {
                depth: 0,
                open: true,
                ..
            }
        ));
        assert!(matches!(rows[1], PlanRow::File { depth: 1, .. }));
        assert!(matches!(rows[5], PlanRow::File { depth: 0, file } if file.name == "top.png"));
    }

    #[test]
    fn a_large_folder_lists_a_page_and_offers_the_rest() {
        let paths: Vec<String> = (0..250).map(|index| format!("big/{index}.jpg")).collect();
        let tree = build_plan_tree(
            paths
                .iter()
                .map(|path| input(SyncPlanAction::Upload, path, 1)),
        );
        let mut overrides = HashMap::new();
        overrides.insert("big".to_owned(), true);
        let rows = flatten_plan_tree(&tree, &overrides, &HashSet::new());
        assert_eq!(rows.len(), 1 + FILES_PER_FOLDER + 1);
        assert!(matches!(
            rows.last(),
            Some(PlanRow::More { hidden: 50, .. })
        ));
        let all = HashSet::from(["big".to_owned()]);
        assert_eq!(flatten_plan_tree(&tree, &overrides, &all).len(), 251);
    }
}
