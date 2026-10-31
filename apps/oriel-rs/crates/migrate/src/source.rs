//! Where Electron Oriel keeps its data, and whether it is running.
//!
//! Electron Oriel keeps the shell's data in `~/.latch-works/oriel` and each mode's in the folder
//! its standalone app used beside it (`frame-view`, `glazier`, `lockstep`), with Sync's shared
//! `hash-cache` and the Lockstep CLI's `lockstep.json` (`packages/app-data`, `main.ts`). It is the
//! same on macOS and Windows. Only a move that failed leaves a folder where Electron first put it,
//! `<appData>/<App>`: `~/Library/Application Support/Oriel` on macOS, `%APPDATA%\Oriel` on
//! Windows.
//!
//! [`IMPORT_FROM_VARIABLE`] names a folder that stands in for the home folder, for tests and dry
//! runs. A run with its own data folder (`ORIEL_RS_DATA_DIR`, which checks and agents set) and no
//! stand-in finds nothing: it never looks in the real home.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_paths::{DATA_DIR_VARIABLE, DataRoot, LATCH_WORKS_DIRECTORY_NAME};

/// Names the folder that stands in for the home folder Electron Oriel's data is under.
pub const IMPORT_FROM_VARIABLE: &str = "ORIEL_RS_IMPORT_FROM";

/// The systems Electron Oriel keeps its data on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
}

impl Platform {
    /// The system this build is for.
    pub const CURRENT: Self = if cfg!(windows) {
        Self::Windows
    } else {
        Self::MacOs
    };

    /// Electron's `appData` under `home`, where a folder Electron Oriel could not move still is.
    fn app_data_under(self, home: &Path) -> PathBuf {
        match self {
            Self::MacOs => home.join("Library").join("Application Support"),
            Self::Windows => home.join("AppData").join("Roaming"),
        }
    }
}

/// One of Electron Oriel's apps, by the folder it keeps under `~/.latch-works` and the name its
/// folder had before.
struct App {
    folder: &'static str,
    legacy: &'static str,
    /// Its name in a refusal while it runs.
    name: &'static str,
    /// Its executable in a Windows task list and its bundle on macOS.
    executable: &'static str,
    bundle: &'static str,
}

/// Electron Oriel and the three standalone apps it replaced, which use the same folders.
const APPS: [App; 4] = [
    App {
        folder: "oriel",
        legacy: "Oriel",
        name: "Electron Oriel",
        executable: "oriel.exe",
        bundle: "/Oriel.app/Contents/MacOS/",
    },
    App {
        folder: "frame-view",
        legacy: "Frame View",
        name: "Frame View",
        executable: "frame-view.exe",
        bundle: "/Frame View.app/Contents/MacOS/",
    },
    App {
        folder: "glazier",
        legacy: "Glazier",
        name: "Glazier",
        executable: "glazier.exe",
        bundle: "/Glazier.app/Contents/MacOS/",
    },
    App {
        folder: "lockstep",
        legacy: "Lockstep",
        name: "Lockstep",
        executable: "lockstep.exe",
        bundle: "/Lockstep.app/Contents/MacOS/",
    },
];

/// Where each piece of Electron Oriel's data is. Nothing here is ever written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElectronData {
    home: PathBuf,
    /// The owner's own home rather than a stand-in, so running apps are looked for by name too.
    owners: bool,
    platform: Platform,
    /// `oriel`, `frame-view`, `glazier`, `lockstep`, in [`APPS`]' order.
    folders: [PathBuf; 4],
    lockstep_config: PathBuf,
    hash_cache: PathBuf,
    legacy_secret_key: PathBuf,
}

impl ElectronData {
    /// Electron Oriel's data for this run: under [`IMPORT_FROM_VARIABLE`]'s folder when it is set;
    /// none at all when `ORIEL_RS_DATA_DIR` is set without it; else under the home folder.
    pub fn from_environment() -> Option<Self> {
        let variable = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
        Self::resolve(
            variable(IMPORT_FROM_VARIABLE),
            variable(DATA_DIR_VARIABLE),
            std::env::home_dir(),
            &Owners {
                app_data: variable("APPDATA").map(PathBuf::from),
                config: variable("XDG_CONFIG_HOME").map(PathBuf::from),
            },
            Platform::CURRENT,
        )
    }

    /// Electron Oriel's data for an app on `data`: [`Self::from_environment`]'s answer, and none
    /// for a data root other than the owner's own (a test's or a check's) unless
    /// [`IMPORT_FROM_VARIABLE`] names a stand-in, so only the owner's run ever reads the real home.
    pub fn for_data_root(data: &DataRoot) -> Option<Self> {
        let owners_root = std::env::home_dir()
            .and_then(|home| DataRoot::under_home(&home).ok())
            .is_some_and(|owners| owners.root() == data.root());
        let stand_in =
            std::env::var_os(IMPORT_FROM_VARIABLE).is_some_and(|value| !value.is_empty());
        (owners_root || stand_in)
            .then(Self::from_environment)
            .flatten()
    }

    /// [`Self::from_environment`] from the values it reads, for tests.
    pub fn resolve(
        import_from: Option<OsString>,
        data_dir: Option<OsString>,
        home: Option<PathBuf>,
        owners: &Owners,
        platform: Platform,
    ) -> Option<Self> {
        if let Some(stand_in) = import_from {
            let stand_in = PathBuf::from(stand_in);
            return stand_in
                .is_absolute()
                .then(|| Self::under(&stand_in, &Owners::default(), false, platform));
        }
        if data_dir.is_some() {
            return None;
        }
        home.map(|home| Self::under(&home, owners, true, platform))
    }

    /// Electron Oriel's data under `home`. A stand-in home keeps everything inside it, so a dry
    /// run reads nothing of the real one.
    pub fn under(home: &Path, owners: &Owners, owner: bool, platform: Platform) -> Self {
        let latch_works = home.join(LATCH_WORKS_DIRECTORY_NAME);
        let app_data = owners
            .app_data
            .clone()
            .filter(|_| owner)
            .unwrap_or_else(|| platform.app_data_under(home));
        let config = owners
            .config
            .clone()
            .filter(|_| owner)
            .unwrap_or_else(|| home.join(".config"));
        let folders = APPS.map(|app| {
            let current = latch_works.join(app.folder);
            let legacy = app_data.join(app.legacy);
            if !current.exists() && legacy.is_dir() {
                legacy
            } else {
                current
            }
        });
        Self {
            home: home.to_path_buf(),
            owners: owner,
            platform,
            folders,
            lockstep_config: latch_works.join("lockstep.json"),
            hash_cache: latch_works.join("hash-cache"),
            legacy_secret_key: config.join("lockstep").join("secret-storage.key"),
        }
    }

    /// The home folder, or the folder standing in for it.
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Whether this is the owner's own home rather than a stand-in.
    pub fn is_owners(&self) -> bool {
        self.owners
    }

    /// The shell's folder: window state, Chromium's storage, `welcomed`, `migration.json`.
    pub fn oriel(&self) -> &Path {
        &self.folders[0]
    }

    /// View's folder (Frame View's).
    pub fn frame_view(&self) -> &Path {
        &self.folders[1]
    }

    /// Tidy's folder (Glazier's).
    pub fn glazier(&self) -> &Path {
        &self.folders[2]
    }

    /// Sync's folder (Lockstep's).
    pub fn lockstep(&self) -> &Path {
        &self.folders[3]
    }

    /// Lockstep's settings from before profiles, which Sync turns into one profile.
    pub fn lockstep_config(&self) -> &Path {
        &self.lockstep_config
    }

    /// Sync's hash cache, shared with the Lockstep CLI.
    pub fn hash_cache(&self) -> &Path {
        &self.hash_cache
    }

    /// Where builds before `~/.latch-works` kept Sync's key (`$XDG_CONFIG_HOME/lockstep`).
    pub fn legacy_secret_key(&self) -> &Path {
        &self.legacy_secret_key
    }

    /// Whether `path` lies inside the home folder this reads, which a dry run never leaves.
    pub fn admits(&self, path: &Path) -> bool {
        self.owners || path.starts_with(&self.home)
    }

    /// Whether any of Electron Oriel's folders is there, a quick look before the survey.
    pub fn exists(&self) -> bool {
        self.folders.iter().any(|folder| folder.is_dir())
            || self.lockstep_config.is_file()
            || self.hash_cache.is_dir()
    }

    /// The apps that are running on this data now, by name. None may run while the import reads:
    /// Electron Oriel and the old apps change the same catalogs and settings.
    ///
    /// Each holds Chromium's single-instance lock in its folder while it runs: on macOS a
    /// `SingletonLock` link naming the host and the process, on Windows a `lockfile` the process
    /// holds open and the system deletes when it ends. On the owner's own home the running
    /// processes are looked for by name as well, as Electron Oriel's `runningOldApps` does.
    pub fn running(&self) -> Vec<&'static str> {
        let listed = if self.owners {
            process_list(self.platform)
        } else {
            String::new()
        };
        APPS.iter()
            .zip(&self.folders)
            .filter(|(app, folder)| {
                holds_lock(folder, self.platform)
                    || match self.platform {
                        Platform::MacOs => listed.contains(app.bundle),
                        Platform::Windows => listed.contains(&format!("\"{}\"", app.executable)),
                    }
            })
            .map(|(app, _)| app.name)
            .collect()
    }
}

/// What the owner's own environment says about where things are; a stand-in home ignores it.
#[derive(Clone, Debug, Default)]
pub struct Owners {
    /// `%APPDATA%` on Windows.
    pub app_data: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME`.
    pub config: Option<PathBuf>,
}

/// Whether a running app holds Chromium's single-instance lock in `folder`.
fn holds_lock(folder: &Path, platform: Platform) -> bool {
    match platform {
        Platform::Windows => folder.join("lockfile").exists(),
        Platform::MacOs => fs::read_link(folder.join("SingletonLock"))
            .ok()
            .and_then(|target| lock_owner(&target.to_string_lossy()))
            .is_some_and(|(host, pid)| host == this_host() && process_runs(pid)),
    }
}

/// The host and process a `SingletonLock` link names: `<host>-<pid>`.
fn lock_owner(target: &str) -> Option<(String, u32)> {
    let (host, pid) = target.rsplit_once('-')?;
    Some((host.to_owned(), pid.parse().ok()?))
}

#[cfg(unix)]
fn this_host() -> String {
    let mut name = [0u8; 256];
    // SAFETY: the buffer is valid for its length, and `gethostname` writes at most that much.
    let failed = unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } != 0;
    if failed {
        return String::new();
    }
    let end = name
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(name.len());
    String::from_utf8_lossy(&name[..end]).into_owned()
}

#[cfg(not(unix))]
fn this_host() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[cfg(unix)]
fn process_runs(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only asks whether the process exists; nothing is sent.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_runs(_pid: u32) -> bool {
    false
}

/// The running processes, as `ps` or `tasklist` lists them; empty when neither answers.
fn process_list(platform: Platform) -> String {
    let output = match platform {
        Platform::MacOs => std::process::Command::new("ps")
            .args(["-A", "-o", "comm="])
            .output(),
        Platform::Windows => std::process::Command::new("tasklist")
            .args(["/fo", "csv", "/nh"])
            .output(),
    };
    output
        .map(|output| {
            let listed = String::from_utf8_lossy(&output.stdout).into_owned();
            match platform {
                Platform::MacOs => listed,
                Platform::Windows => listed.to_lowercase(),
            }
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owners() -> Owners {
        Owners {
            app_data: Some(PathBuf::from("/owner/AppData/Roaming")),
            config: Some(PathBuf::from("/owner/.config")),
        }
    }

    #[test]
    fn a_scratch_data_folder_without_a_stand_in_finds_nothing() {
        let home = Some(PathBuf::from("/Users/someone"));
        let data_dir = Some(OsString::from("/tmp/scratch"));
        assert_eq!(
            ElectronData::resolve(
                None,
                data_dir.clone(),
                home.clone(),
                &owners(),
                Platform::MacOs
            ),
            None
        );
        let stand_in = ElectronData::resolve(
            Some(OsString::from("/tmp/fake-home")),
            data_dir,
            home.clone(),
            &owners(),
            Platform::MacOs,
        )
        .unwrap();
        assert_eq!(stand_in.home(), Path::new("/tmp/fake-home"));
        assert!(!stand_in.is_owners());
        // A relative stand-in is refused rather than read against the working folder.
        assert_eq!(
            ElectronData::resolve(
                Some(OsString::from("fake")),
                None,
                home.clone(),
                &owners(),
                Platform::MacOs
            ),
            None
        );
        let real = ElectronData::resolve(None, None, home, &owners(), Platform::MacOs).unwrap();
        assert!(real.is_owners());
        assert_eq!(
            real.glazier(),
            Path::new("/Users/someone/.latch-works/glazier")
        );
    }

    #[test]
    fn a_data_root_other_than_the_owners_finds_nothing_without_a_stand_in() {
        if std::env::var_os(IMPORT_FROM_VARIABLE).is_some() {
            return;
        }
        let scratch = DataRoot::at(std::env::temp_dir().join("oriel-migrate-not-the-owners"));
        assert_eq!(ElectronData::for_data_root(&scratch.unwrap()), None);
    }

    #[test]
    fn every_folder_of_a_stand_in_stays_inside_it() {
        for platform in [Platform::MacOs, Platform::Windows] {
            let data = ElectronData::under(Path::new("/tmp/fake"), &owners(), false, platform);
            for path in [
                data.oriel(),
                data.frame_view(),
                data.glazier(),
                data.lockstep(),
                data.lockstep_config(),
                data.hash_cache(),
                data.legacy_secret_key(),
            ] {
                assert!(path.starts_with("/tmp/fake"), "{} left it", path.display());
            }
            assert!(!data.admits(Path::new("/Volumes/Photos/.latch-works/glazier/holding")));
        }
    }

    #[test]
    fn a_folder_electron_could_not_move_is_found_where_it_was() {
        let home =
            std::env::temp_dir().join(format!("oriel-migrate-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        // Windows: `%APPDATA%\Glazier` under a stand-in is `<home>\AppData\Roaming\Glazier`.
        fs::create_dir_all(home.join("AppData/Roaming/Glazier")).unwrap();
        fs::create_dir_all(home.join(".latch-works/oriel")).unwrap();
        let windows = ElectronData::under(&home, &owners(), false, Platform::Windows);
        assert_eq!(windows.glazier(), home.join("AppData/Roaming/Glazier"));
        assert_eq!(windows.oriel(), home.join(".latch-works/oriel"));
        assert_eq!(windows.lockstep(), home.join(".latch-works/lockstep"));
        // macOS: `~/Library/Application Support/<App>`; the Windows folder means nothing there.
        let mac = ElectronData::under(&home, &owners(), false, Platform::MacOs);
        assert_eq!(mac.glazier(), home.join(".latch-works/glazier"));
        fs::create_dir_all(home.join("Library/Application Support/Frame View")).unwrap();
        let mac = ElectronData::under(&home, &owners(), false, Platform::MacOs);
        assert_eq!(
            mac.frame_view(),
            home.join("Library/Application Support/Frame View")
        );
        // The owner's own `%APPDATA%` counts only for the owner's own home.
        let owner = ElectronData::under(&home, &owners(), true, Platform::Windows);
        assert_eq!(owner.glazier(), home.join(".latch-works/glazier"));
        assert_eq!(
            owner.legacy_secret_key(),
            Path::new("/owner/.config/lockstep/secret-storage.key")
        );
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_singleton_lock_counts_while_its_process_runs_on_this_host() {
        assert_eq!(
            lock_owner("Some-Mac.local-4321"),
            Some(("Some-Mac.local".to_owned(), 4321))
        );
        assert_eq!(lock_owner("garbage"), None);
        let home = std::env::temp_dir().join(format!("oriel-migrate-lock-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let oriel = home.join(".latch-works/oriel");
        fs::create_dir_all(&oriel).unwrap();
        let data = ElectronData::under(&home, &Owners::default(), false, Platform::MacOs);
        assert!(data.running().is_empty());
        #[cfg(unix)]
        {
            let lock = oriel.join("SingletonLock");
            let link = |target: String| {
                let _ = fs::remove_file(&lock);
                std::os::unix::fs::symlink(target, &lock).unwrap();
            };
            link(format!("{}-{}", this_host(), std::process::id()));
            assert_eq!(data.running(), ["Electron Oriel"]);
            // A lock a crash left, naming a process that has ended, or another computer's.
            link(format!("{}-{}", this_host(), i32::MAX));
            assert!(data.running().is_empty());
            link(format!("another-host-{}", std::process::id()));
            assert!(data.running().is_empty());
        }
        // Windows' `lockfile` exists only while the process holds it.
        fs::write(home.join(".latch-works/oriel/lockfile"), b"").unwrap();
        let windows = ElectronData::under(&home, &Owners::default(), false, Platform::Windows);
        assert_eq!(windows.running(), ["Electron Oriel"]);
        fs::remove_dir_all(&home).unwrap();
    }
}
