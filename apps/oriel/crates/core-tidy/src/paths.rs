//! Tidy's path rules: what lies inside a root, and where a sandboxed run may work. The engine
//! decides with them and Tidy's pages word and show what they decide.

use std::path::{Component, Path, PathBuf};

use oriel_core_paths::DataRoot;

/// `target`'s place inside `root` with `/` between names, `""` for the root itself, or `None`
/// when it lies outside. `.` and `..` are resolved by name first, as Node's `path.relative`
/// does. On Windows names compare ignoring case, as NTFS does.
pub fn relative_within(target: &Path, root: &Path) -> Option<String> {
    let (target, root) = (names(target), names(root));
    let inside = target.len() >= root.len()
        && target
            .iter()
            .zip(&root)
            .all(|(target, root)| same_name(target, root));
    inside.then(|| target[root.len()..].join("/"))
}

/// Whether `target` is `root` or inside it; see [`relative_within`].
pub fn is_within(target: &Path, root: &Path) -> bool {
    relative_within(target, root).is_some()
}

/// Whether one folder holds the other, or they are one: roots never overlap, so every file
/// belongs to exactly one.
pub fn roots_overlap(left: &Path, right: &Path) -> bool {
    is_within(left, right) || is_within(right, left)
}

/// Where a sandboxed run (`ORIEL_DATA_DIR` set) lets Tidy work, in one sentence, for wherever a
/// folder or a move is refused by [`DataRoot::admits_tidy_root`].
pub fn sandbox_rule(data: &DataRoot) -> String {
    format!(
        "With ORIEL_DATA_DIR set, Tidy works only on folders inside {} or the temp folder.",
        data.sandbox().display()
    )
}

fn names(path: &Path) -> Vec<String> {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect()
}

fn same_name(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_inside_a_root_by_whole_names() {
        let within = |target: &str, root: &str| relative_within(Path::new(target), Path::new(root));
        assert_eq!(within("/r/a/b", "/r").as_deref(), Some("a/b"));
        assert_eq!(within("/r", "/r").as_deref(), Some(""));
        assert_eq!(within("/rb/a", "/r"), None);
        // A folder whose name starts with two dots is a folder like any other.
        assert_eq!(within("/r/..x", "/r").as_deref(), Some("..x"));
        assert_eq!(within("/r/../x", "/r"), None);
        assert!(roots_overlap(Path::new("/r"), Path::new("/r/a")));
        assert!(!roots_overlap(Path::new("/r/a"), Path::new("/r/b")));
    }
}
