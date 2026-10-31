//! Every folder Oriel keeps, and nothing else.
//!
//! Oriel keeps its data in one root, `~/.latch-works/oriel` (`%USERPROFILE%\.latch-works\oriel`
//! on Windows). Every path the app keeps comes from [`DataRoot`], so a path that leaves the root
//! is a bug here rather than a stray write somewhere else.
//!
//! Tidy changes files in any folder the owner adds, as Electron Oriel's does (plan 063, decision
//! 18). A run with [`DATA_DIR_VARIABLE`] set (the checks, the tests, agents) is sandboxed instead:
//! Tidy takes only roots inside [`DataRoot::sandbox`] or the temp folder, so nothing a check
//! runs can change the owner's archive.

use std::{
    env, io,
    path::{Component, Path, PathBuf},
};

/// The folder under the home folder every Latch Works app keeps its data in.
pub const LATCH_WORKS_DIRECTORY_NAME: &str = ".latch-works";

/// Oriel's own folder under it.
pub const APP_DIRECTORY_NAME: &str = "oriel";

/// Replaces the root, for tests and end-to-end runs, as `--user-data-dir` did for Electron
/// Oriel.
pub const DATA_DIR_VARIABLE: &str = "ORIEL_DATA_DIR";

/// Oriel's data root and the folders under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRoot {
    root: PathBuf,
    /// Whether Tidy keeps to [`Self::sandbox`] and the temp folder: true for a root chosen by
    /// [`DATA_DIR_VARIABLE`] or [`Self::at`], false for the owner's own root.
    sandboxed: bool,
}

impl DataRoot {
    /// The root for this run: [`DATA_DIR_VARIABLE`] when it is set, sandboxed, else
    /// `~/.latch-works/oriel`, where Tidy takes any folder.
    pub fn from_environment() -> io::Result<Self> {
        if let Some(chosen) = env::var_os(DATA_DIR_VARIABLE).filter(|value| !value.is_empty()) {
            return Self::at(PathBuf::from(chosen));
        }
        let home = env::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No home folder."))?;
        Self::under_home(&home)
    }

    /// The owner's root under `home`, `home/.latch-works/oriel`, where Tidy takes any folder.
    pub fn under_home(home: &Path) -> io::Result<Self> {
        let mut data = Self::at(
            home.join(LATCH_WORKS_DIRECTORY_NAME)
                .join(APP_DIRECTORY_NAME),
        )?;
        data.sandboxed = false;
        Ok(data)
    }

    /// A sandboxed root at `root`, for checks and tests, which must be absolute.
    pub fn at(root: PathBuf) -> io::Result<Self> {
        if !root.is_absolute() {
            return Err(invalid(format!(
                "The data folder {} is not absolute.",
                root.display()
            )));
        }
        Ok(Self {
            root: normalize(&root),
            sandboxed: true,
        })
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

    /// Sync's hash cache, in the same format as Electron Oriel's.
    pub fn hash_cache(&self) -> PathBuf {
        self.root.join("hash-cache")
    }

    /// The only place, with the temp folder, a Tidy root may be in a sandboxed run.
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

    /// Whether Tidy keeps to [`Self::sandbox`] and the temp folder in this run.
    pub fn is_sandboxed(&self) -> bool {
        self.sandboxed
    }

    /// Whether Tidy may change files in `root`. Any absolute folder in the owner's run; in a
    /// sandboxed one, only inside [`Self::sandbox`] or the temp folder, and never the sandbox or
    /// the temp folder itself. Electron Oriel's own refusals (a folder that is missing, a file,
    /// or one overlapping another root) are the catalog's to make, in either run.
    pub fn admits_tidy_root(&self, root: &Path) -> bool {
        if !root.is_absolute() {
            return false;
        }
        if !self.sandboxed {
            return true;
        }
        let root = normalize(root);
        let temp = normalize(&env::temp_dir());
        // The temp folder can sit behind a symlink (`/var` is `/private/var` on macOS), so both
        // spellings count.
        let temp_resolved = std::fs::canonicalize(&temp).unwrap_or_else(|_| temp.clone());
        // So can the data root itself (`ORIEL_DATA_DIR=/tmp/…`), and callers often hand over a
        // canonical path.
        let sandbox = self.sandbox();
        let sandbox_resolved = std::fs::canonicalize(&sandbox).unwrap_or_else(|_| sandbox.clone());
        [sandbox, sandbox_resolved, temp, temp_resolved]
            .iter()
            .any(|allowed| root.starts_with(allowed) && root != *allowed)
    }
}

/// `path` with `.` and `..` resolved lexically, so `root/../other` cannot pass for `root/…`.
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
        assert_eq!(data.root(), Path::new("/Users/someone/.latch-works/oriel"));
        for folder in data.folders() {
            assert!(data.contains(&folder), "{} left the root", folder.display());
            assert_ne!(folder, data.root());
        }
    }

    #[test]
    fn refuses_a_relative_root() {
        assert!(DataRoot::at(PathBuf::from("relative/root")).is_err());
    }

    #[test]
    fn a_path_climbing_out_is_not_inside() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert!(!data.contains(&data.root().join("view/../../other/settings.json")));
        assert!(data.contains(&data.root().join("view/./thumbnails")));
        assert!(!data.contains(Path::new("view")));
    }

    #[test]
    fn a_sandboxed_run_keeps_tidy_roots_in_the_sandbox_or_the_temp_folder() {
        let data = DataRoot::at(home().join("scratch/data")).unwrap();
        assert!(data.is_sandboxed());
        assert!(data.admits_tidy_root(&data.sandbox().join("archive")));
        assert!(data.admits_tidy_root(&env::temp_dir().join("glazier-run/archive")));
        assert!(!data.admits_tidy_root(&data.sandbox()));
        assert!(!data.admits_tidy_root(&env::temp_dir()));
        assert!(!data.admits_tidy_root(&home().join("Pictures")));
        assert!(!data.admits_tidy_root(&data.sandbox().join("../view")));
        assert!(!data.admits_tidy_root(Path::new("sandbox/archive")));
    }

    #[test]
    fn the_owners_run_takes_any_absolute_tidy_root() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert!(!data.is_sandboxed());
        assert!(data.admits_tidy_root(&home().join("Pictures")));
        assert!(data.admits_tidy_root(Path::new("/Volumes/Archive")));
        assert!(data.admits_tidy_root(&data.sandbox().join("archive")));
        assert!(!data.admits_tidy_root(Path::new("Pictures")));
    }
}
