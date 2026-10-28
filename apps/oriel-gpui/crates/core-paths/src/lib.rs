//! Every folder Oriel GPUI keeps, and nothing else.
//!
//! Oriel GPUI keeps its data in one root, `~/.latch-works/oriel-gpui`, and never reads or writes
//! Electron Oriel's folders beside it (`oriel`, `frame-view`, `glazier`, `lockstep`,
//! `lockstep.json`, `hash-cache`). Every path the app keeps comes from [`DataRoot`], so a path
//! that leaves the root is a bug here rather than a stray write somewhere else.
//!
//! Tidy changes files only in a root inside [`DataRoot::sandbox`] or the temp folder, until the
//! owner lifts the sandbox (plan 063, ground rules).

use std::{
    env, io,
    path::{Component, Path, PathBuf},
};

/// The folder under the home folder every Latch Works app keeps its data in.
pub const LATCH_WORKS_DIRECTORY_NAME: &str = ".latch-works";

/// Oriel GPUI's own folder under it.
pub const APP_DIRECTORY_NAME: &str = "oriel-gpui";

/// Replaces the root, for tests and end-to-end runs, as `--user-data-dir` does for Electron
/// Oriel.
pub const DATA_DIR_VARIABLE: &str = "ORIEL_GPUI_DATA_DIR";

/// What Electron Oriel and its predecessors keep under `~/.latch-works`. Oriel GPUI must not
/// touch any of them.
pub const ORIEL_ENTRIES: [&str; 6] = [
    "oriel",
    "frame-view",
    "glazier",
    "lockstep",
    "lockstep.json",
    "hash-cache",
];

/// Oriel GPUI's data root and the folders under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRoot {
    root: PathBuf,
}

impl DataRoot {
    /// The root for this run: [`DATA_DIR_VARIABLE`] when it is set, else
    /// `~/.latch-works/oriel-gpui`.
    pub fn from_environment() -> io::Result<Self> {
        if let Some(chosen) = env::var_os(DATA_DIR_VARIABLE).filter(|value| !value.is_empty()) {
            return Self::at(PathBuf::from(chosen));
        }
        let home = env::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No home folder."))?;
        Self::under_home(&home)
    }

    /// The root under `home`: `home/.latch-works/oriel-gpui`.
    pub fn under_home(home: &Path) -> io::Result<Self> {
        Self::at(
            home.join(LATCH_WORKS_DIRECTORY_NAME)
                .join(APP_DIRECTORY_NAME),
        )
    }

    /// A root at `root`, which must be absolute and must not be one of Electron Oriel's folders
    /// or inside one.
    pub fn at(root: PathBuf) -> io::Result<Self> {
        if !root.is_absolute() {
            return Err(invalid(format!(
                "The data folder {} is not absolute.",
                root.display()
            )));
        }
        let root = normalize(&root);
        if let Some(entry) = oriel_entry_containing(&root) {
            return Err(invalid(format!(
                "The data folder {} is Electron Oriel's `{entry}`; Oriel GPUI keeps its own.",
                root.display()
            )));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The window, the last mode and page, the shell's settings.
    pub fn shell(&self) -> PathBuf {
        self.root.join("shell")
    }

    /// View's index, thumbnails and settings.
    pub fn view(&self) -> PathBuf {
        self.root.join("view")
    }

    /// Tidy's catalogs, journals and settings.
    pub fn tidy(&self) -> PathBuf {
        self.root.join("tidy")
    }

    /// Sync's profiles and secrets.
    pub fn sync(&self) -> PathBuf {
        self.root.join("sync")
    }

    /// Sync's hash cache, in the same format as Electron Oriel's but apart from it.
    pub fn hash_cache(&self) -> PathBuf {
        self.root.join("hash-cache")
    }

    /// The only place, with the temp folder, a Tidy root may be while the sandbox holds.
    pub fn sandbox(&self) -> PathBuf {
        self.root.join("sandbox")
    }

    /// Every folder above, to create at start.
    pub fn folders(&self) -> [PathBuf; 6] {
        [
            self.shell(),
            self.view(),
            self.tidy(),
            self.sync(),
            self.hash_cache(),
            self.sandbox(),
        ]
    }

    pub fn create_folders(&self) -> io::Result<()> {
        self.folders().iter().try_for_each(std::fs::create_dir_all)
    }

    /// Whether `path` lies inside the root.
    pub fn contains(&self, path: &Path) -> bool {
        path.is_absolute() && normalize(path).starts_with(&self.root)
    }

    /// Whether Tidy may change files in `root` while the sandbox holds: inside
    /// [`Self::sandbox`] or the temp folder, and never the sandbox or the temp folder itself.
    pub fn admits_tidy_root(&self, root: &Path) -> bool {
        if !root.is_absolute() {
            return false;
        }
        let root = normalize(root);
        let temp = normalize(&env::temp_dir());
        // The temp folder can sit behind a symlink (`/var` is `/private/var` on macOS), so both
        // spellings count.
        let temp_resolved = std::fs::canonicalize(&temp).unwrap_or_else(|_| temp.clone());
        [self.sandbox(), temp, temp_resolved]
            .iter()
            .any(|allowed| root.starts_with(allowed) && root != *allowed)
    }
}

/// The Electron Oriel entry under `~/.latch-works` that `path` is or lies in, if any.
fn oriel_entry_containing(path: &Path) -> Option<&'static str> {
    let components: Vec<_> = path.components().collect();
    components.windows(2).find_map(|pair| match pair {
        [Component::Normal(parent), Component::Normal(child)]
            if *parent == LATCH_WORKS_DIRECTORY_NAME =>
        {
            ORIEL_ENTRIES
                .iter()
                .find(|entry| *child == **entry)
                .copied()
        }
        _ => None,
    })
}

/// `path` with `.` and `..` resolved lexically, so `root/../oriel` cannot pass for `root/…`.
fn normalize(path: &Path) -> PathBuf {
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
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/someone")
    }

    #[test]
    fn every_folder_stays_inside_the_root() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert_eq!(
            data.root(),
            Path::new("/Users/someone/.latch-works/oriel-gpui")
        );
        for folder in data.folders() {
            assert!(data.contains(&folder), "{} left the root", folder.display());
            assert_ne!(folder, data.root());
        }
    }

    #[test]
    fn no_folder_belongs_to_electron_oriel() {
        let data = DataRoot::under_home(&home()).unwrap();
        let latch_works = home().join(LATCH_WORKS_DIRECTORY_NAME);
        for entry in ORIEL_ENTRIES {
            let theirs = latch_works.join(entry);
            assert!(!data.contains(&theirs));
            for folder in data.folders() {
                assert!(
                    !folder.starts_with(&theirs),
                    "{} is under {entry}",
                    folder.display()
                );
            }
        }
    }

    #[test]
    fn refuses_electron_oriel_folders_as_the_root() {
        let latch_works = home().join(LATCH_WORKS_DIRECTORY_NAME);
        for entry in ORIEL_ENTRIES {
            assert!(
                DataRoot::at(latch_works.join(entry)).is_err(),
                "{entry} was accepted"
            );
            assert!(DataRoot::at(latch_works.join(entry).join("inner")).is_err());
        }
        assert!(DataRoot::at(latch_works.join("oriel-gpui/../oriel")).is_err());
        assert!(DataRoot::at(PathBuf::from("relative/root")).is_err());
    }

    #[test]
    fn a_path_climbing_out_is_not_inside() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert!(!data.contains(&data.root().join("view/../../oriel/settings.json")));
        assert!(data.contains(&data.root().join("view/./thumbnails")));
        assert!(!data.contains(Path::new("view")));
    }

    #[test]
    fn tidy_roots_stay_in_the_sandbox_or_the_temp_folder() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert!(data.admits_tidy_root(&data.sandbox().join("archive")));
        assert!(data.admits_tidy_root(&env::temp_dir().join("glazier-run/archive")));
        assert!(!data.admits_tidy_root(&data.sandbox()));
        assert!(!data.admits_tidy_root(&env::temp_dir()));
        assert!(!data.admits_tidy_root(&home().join("Pictures")));
        assert!(!data.admits_tidy_root(&data.sandbox().join("../view")));
        assert!(!data.admits_tidy_root(Path::new("sandbox/archive")));
    }
}
