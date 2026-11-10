//! Oriel's data root and every folder and file it keeps there.
//!
//! Oriel keeps its data in one root, `~/.latch-works/oriel` (`%USERPROFILE%\.latch-works\oriel`
//! on Windows). Tidy changes files in any folder the owner adds (plan 063, decision 18). A root
//! chosen for a run ([`DataRoot::at`]: the checks, the tests, agents) is sandboxed instead: Tidy
//! takes only roots inside [`DataRoot::sandbox`] or the temp folder, so nothing a check runs can
//! change the owner's archive.
//!
//! The file names are the ones Electron Oriel wrote, so a data folder it left reads as it was.

use std::{
    env, io,
    path::{Component, Path, PathBuf},
};

use oriel_core_domain::LATCH_WORKS_DIRECTORY_NAME;

/// Oriel's own folder under it.
pub const APP_DIRECTORY_NAME: &str = "oriel";

/// The folder holding takes, in Tidy's folder and at the top of another volume.
const HOLDING: &str = "holding";

/// Oriel's data root and the folders and files under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRoot {
    root: PathBuf,
    /// Whether Tidy keeps to [`Self::sandbox`] and the temp folder: true for a root chosen with
    /// [`Self::at`], false for the owner's own root.
    sandboxed: bool,
}

impl DataRoot {
    /// The owner's root, `~/.latch-works/oriel`, where Tidy takes any folder.
    pub fn of_owner() -> io::Result<Self> {
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

    /// The lock one running Oriel holds on this root.
    pub fn instance_lock(&self) -> PathBuf {
        self.root.join("instance.lock")
    }

    /// The socket a later start hands its paths into, on macOS.
    pub fn instance_socket(&self) -> PathBuf {
        self.root.join("instance.sock")
    }

    /// The shell's folder: the window, the stored preferences, the first-start marks.
    pub fn shell(&self) -> PathBuf {
        self.root.join("shell")
    }

    /// Where the window was and whether it was maximized.
    pub fn window_state(&self) -> PathBuf {
        self.shell().join("window-state.json")
    }

    /// The window's preferences, what `localStorage` held for Electron Oriel.
    pub fn local_storage(&self) -> PathBuf {
        self.shell().join("local-storage.json")
    }

    /// There once the first-start welcome is done.
    pub fn welcomed(&self) -> PathBuf {
        self.shell().join("welcomed")
    }

    /// There once the owner declined to move the app into Applications.
    pub fn move_to_applications_declined(&self) -> PathBuf {
        self.shell().join("move-to-applications-declined")
    }

    /// View's folder.
    pub fn view(&self) -> PathBuf {
        self.root.join("view")
    }

    /// View's settings and remembered folders.
    pub fn view_settings(&self) -> PathBuf {
        self.view().join("frame-view-settings.json")
    }

    /// The index of each scan earlier builds of View wrote and nothing read, and its SQLite
    /// sidecars: View deletes them.
    pub fn retired_view_media_index(&self) -> [PathBuf; 3] {
        [
            "media-index.sqlite",
            "media-index.sqlite-wal",
            "media-index.sqlite-shm",
        ]
        .map(|name| self.view().join(name))
    }

    /// View's thumbnails, one WebP file each.
    pub fn view_thumbnails(&self) -> PathBuf {
        self.view().join("frame-view").join("thumbnails")
    }

    /// What View makes once and keeps, such as the clip that primes the video engine.
    pub fn view_cache(&self) -> PathBuf {
        self.view().join("cache")
    }

    /// Tidy's folder: its catalog, journals and holding.
    pub fn tidy(&self) -> PathBuf {
        self.root.join("tidy")
    }

    /// Tidy's catalog.
    pub fn tidy_catalog(&self) -> PathBuf {
        self.tidy().join("catalog.sqlite")
    }

    /// Where Tidy holds what a change takes out of a root on the data folder's volume.
    pub fn tidy_holding(&self) -> PathBuf {
        self.tidy().join(HOLDING)
    }

    /// Where Tidy holds what a change takes out of a root on the volume mounted at `mount`:
    /// `.latch-works/oriel/holding` at its top, so holding there is a rename.
    pub fn volume_holding(mount: &Path) -> PathBuf {
        mount
            .join(LATCH_WORKS_DIRECTORY_NAME)
            .join(APP_DIRECTORY_NAME)
            .join(HOLDING)
    }

    /// The folder `path` lies under as a [`Self::volume_holding`], the highest one when there are
    /// several.
    pub fn volume_holding_mount(path: &Path) -> Option<&Path> {
        path.ancestors()
            .filter(|folder| {
                let names: Vec<_> = folder
                    .components()
                    .rev()
                    .take(3)
                    .map(Component::as_os_str)
                    .collect();
                names == [HOLDING, APP_DIRECTORY_NAME, LATCH_WORKS_DIRECTORY_NAME]
            })
            .last()
            .and_then(|holding| holding.parent()?.parent()?.parent())
    }

    /// Sync's folder: its profiles and secrets.
    pub fn sync(&self) -> PathBuf {
        self.root.join("sync")
    }

    /// Sync's profiles, Lockstep's settings file.
    pub fn sync_settings(&self) -> PathBuf {
        self.sync().join("lockstep-settings.json")
    }

    /// The key Sync's stored tokens are sealed with.
    pub fn sync_secret_key(&self) -> PathBuf {
        self.sync().join("secret-storage.key")
    }

    /// Sync's hash cache, in the same format as Electron Oriel's.
    pub fn hash_cache(&self) -> PathBuf {
        self.root.join("hash-cache")
    }

    /// The only place, with the temp folder, a Tidy root may be in a sandboxed run.
    pub fn sandbox(&self) -> PathBuf {
        self.root.join("sandbox")
    }

    /// Where a sandboxed run sends what the owner's run sends to the system Trash.
    pub fn sandbox_trash(&self) -> PathBuf {
        self.root.join("sandbox-trash")
    }

    /// Moves a file or folder into [`Self::sandbox_trash`], under a name of its own if that one is
    /// taken, as the Trash does, and says where it went.
    pub fn move_to_sandbox_trash(&self, path: &Path) -> io::Result<PathBuf> {
        let trash = self.sandbox_trash();
        std::fs::create_dir_all(&trash)?;
        let name = path
            .file_name()
            .ok_or_else(|| invalid(format!("{} has no name to keep.", path.display())))?;
        let mut target = trash.join(name);
        let mut copy = 1;
        while target.symlink_metadata().is_ok() {
            copy += 1;
            let mut numbered = name.to_os_string();
            numbered.push(format!(" {copy}"));
            target = trash.join(numbered);
        }
        std::fs::rename(path, &target)?;
        Ok(target)
    }

    /// Every folder created at start.
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

    /// Whether Tidy keeps to [`Self::sandbox`] and the temp folder in this run.
    pub fn is_sandboxed(&self) -> bool {
        self.sandboxed
    }

    /// Whether Tidy may change files in `root`. Any absolute folder in the owner's run; in a
    /// sandboxed one, only inside [`Self::sandbox`] or the temp folder, and never the sandbox or
    /// the temp folder itself. A folder that is missing, a file, or one overlapping another root
    /// is the catalog's to refuse, in either run.
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
        // So can the data root itself (`/tmp/…`), and callers often hand over a canonical path.
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
        PathBuf::from(if cfg!(windows) {
            r"C:\Users\someone"
        } else {
            "/Users/someone"
        })
    }

    #[test]
    fn every_folder_stays_inside_the_root() {
        let data = DataRoot::under_home(&home()).unwrap();
        assert_eq!(data.root(), home().join(".latch-works").join("oriel"));
        for folder in data.folders() {
            assert!(folder.starts_with(data.root()), "{}", folder.display());
            assert_ne!(folder, data.root());
        }
    }

    #[test]
    fn refuses_a_relative_root() {
        assert!(DataRoot::at(PathBuf::from("relative/root")).is_err());
    }

    #[test]
    fn a_sandboxed_run_keeps_tidy_roots_in_the_sandbox_or_the_temp_folder() {
        let data = DataRoot::at(home().join("scratch/data")).unwrap();
        assert!(data.is_sandboxed());
        assert!(data.admits_tidy_root(&data.sandbox().join("archive")));
        assert!(data.admits_tidy_root(&env::temp_dir().join("tidy-run/archive")));
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
        let volume = if cfg!(windows) {
            r"D:\Archive"
        } else {
            "/Volumes/Archive"
        };
        assert!(data.admits_tidy_root(Path::new(volume)));
        assert!(data.admits_tidy_root(&data.sandbox().join("archive")));
        assert!(!data.admits_tidy_root(Path::new("Pictures")));
    }

    #[test]
    fn the_sandbox_trash_takes_files_and_folders_and_keeps_both_of_one_name() {
        let top = env::temp_dir().join(format!("oriel-paths-trash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        let data = DataRoot::at(top.join("data")).unwrap();
        let folder = top.join("batch");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("held.png"), b"first").unwrap();
        let first = data.move_to_sandbox_trash(&folder).unwrap();
        assert_eq!(first, data.sandbox_trash().join("batch"));
        assert!(!folder.exists());
        assert_eq!(std::fs::read(first.join("held.png")).unwrap(), b"first");

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("held.png"), b"second").unwrap();
        let second = data.move_to_sandbox_trash(&folder).unwrap();
        assert_eq!(second, data.sandbox_trash().join("batch 2"));
        assert_eq!(std::fs::read(first.join("held.png")).unwrap(), b"first");
        std::fs::remove_dir_all(&top).unwrap();
    }
}
