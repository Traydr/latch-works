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
    /// Its [`TreeInput::item`].
    pub item: usize,
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
    /// Where the item came from, such as its place in the plan; the tree hands it back.
    pub item: usize,
    /// Where its file name falls in natural order among the names the tree may hold, from
    /// [`name_order`]. A folder's files are sorted by it, which sorts them by name.
    pub name_rank: u32,
}

/// The [`TreeInput::name_rank`] of each path, in order: where its file name falls in natural
/// order, the same rank for names that compare equal. Worked out once for a plan, it sorts the
/// plan's tree, of any subset of its changes, without the collator.
pub fn name_order<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<u32> {
    let names: Vec<&str> = paths
        .into_iter()
        .map(|path| path.rsplit('/').next().unwrap_or(path))
        .collect();
    let count = u32::try_from(names.len()).expect("a plan's changes fit in u32");
    let mut order: Vec<u32> = (0..count).collect();
    let name = |at: u32| names[at as usize];
    order.sort_by(|a, b| natural(name(*a), name(*b)));
    let mut ranks = vec![0; names.len()];
    let mut rank = 0;
    for pair in order.windows(2) {
        if natural(name(pair[0]), name(pair[1])) != std::cmp::Ordering::Equal {
            rank += 1;
        }
        ranks[pair[1] as usize] = rank;
    }
    ranks
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
    /// Each file with its name's rank.
    files: Vec<(u32, PlanFile)>,
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
        folder.files.push((
            item.name_rank,
            PlanFile {
                action: item.action,
                name,
                path: item.path.to_owned(),
                size: if item.action == SyncPlanAction::Delete {
                    None
                } else {
                    item.size
                },
                item: item.item,
            },
        ));
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
    // Stable, so names that rank equal keep their order, as a sort by `natural` keeps them.
    let mut files = draft.files;
    files.sort_by_key(|(rank, _)| *rank);
    let files: Vec<PlanFile> = files.into_iter().map(|(_, file)| file).collect();
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

/// The [`TreeInput::item`] of every file in `folder` and below it.
pub fn folder_items(folder: &PlanFolder) -> Vec<usize> {
    let mut items = Vec::with_capacity(folder.item_count);
    collect_items(folder, &mut items);
    items
}

fn collect_items(folder: &PlanFolder, items: &mut Vec<usize>) {
    items.extend(folder.files.iter().map(|file| file.item));
    for child in &folder.folders {
        collect_items(child, items);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tree of `changes`, each ranked among them all as a plan ranks its changes.
    fn tree_of(changes: &[(SyncPlanAction, &str, u64)]) -> PlanFolder {
        let ranks = name_order(changes.iter().map(|(_, path, _)| *path));
        build_plan_tree(changes.iter().zip(ranks).enumerate().map(
            |(item, ((action, path, size), name_rank))| TreeInput {
                action: *action,
                path,
                size: Some(*size),
                item,
                name_rank,
            },
        ))
    }

    #[test]
    fn groups_changes_into_sorted_folders_and_collapses_chains() {
        let tree = tree_of(&[
            (SyncPlanAction::Upload, "b/10.jpg", 10),
            (SyncPlanAction::Upload, "b/2.jpg", 2),
            (SyncPlanAction::Delete, "a/x/y/gone.jpg", 99),
            (SyncPlanAction::Update, "top.png", 5),
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
        assert_eq!(
            folder_items(&tree.folders[1]),
            [1, 0],
            "in the order the tree lists them"
        );
    }

    #[test]
    fn a_large_folder_lists_a_page_and_offers_the_rest() {
        let paths: Vec<String> = (0..250).map(|index| format!("big/{index}.jpg")).collect();
        let changes: Vec<(SyncPlanAction, &str, u64)> = paths
            .iter()
            .map(|path| (SyncPlanAction::Upload, path.as_str(), 1))
            .collect();
        let tree = tree_of(&changes);
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
