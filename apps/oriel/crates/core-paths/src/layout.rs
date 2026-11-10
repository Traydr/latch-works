//! What the app is called and how its files are laid out on disk: in the package xtask makes
//! (the Mac's `Oriel.app`, the folder Windows' Setup.exe installs) and in the workspace while
//! developing. xtask writes these places and the app reads them, both through this module.

use std::path::{Path, PathBuf};

/// The app's name, in the menu bar, the bundle and the installer.
pub const APP_NAME: &str = "Oriel";

/// The bundle id, which macOS and the window system know the app by.
pub const BUNDLE_ID: &str = "dev.traydr.latchworks.oriel";

/// The executable's name in the Mac bundle, `Contents/MacOS/oriel`.
pub const MAC_EXECUTABLE: &str = "oriel";

/// The executable's name in the Windows package.
pub const WINDOWS_EXECUTABLE: &str = "oriel.exe";

/// The folder a set's newest build is reached through, in `.vendor/<set>/` and `.libmpv/`.
pub const CURRENT: &str = "current";

/// The folder of licence notices names its folders in this file, for the About dialog.
pub const NOTICE_INDEX_FILE: &str = "index.json";

/// Where a packaged app keeps what it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Package {
    /// A Mac bundle, by its `Contents` folder.
    MacBundle(PathBuf),
    /// The folder Windows' installer fills, which holds the executable.
    WindowsFolder(PathBuf),
}

impl Package {
    /// The package this process runs from, or `None` for a development build.
    pub fn of_running_app() -> Option<Self> {
        Self::of_executable(&std::env::current_exe().ok()?)
    }

    /// The package `executable` runs from: the bundle whose `Contents/MacOS` holds it, or on
    /// Windows its folder once that holds the licence notices every package carries.
    pub fn of_executable(executable: &Path) -> Option<Self> {
        let folder = executable.parent()?;
        if cfg!(windows) {
            let package = Self::WindowsFolder(folder.to_path_buf());
            return package.licenses().is_dir().then_some(package);
        }
        let contents = folder.parent()?;
        (folder.file_name()? == "MacOS" && contents.file_name()? == "Contents")
            .then(|| Self::MacBundle(contents.to_path_buf()))
    }

    /// `Contents/MacOS` in a bundle.
    pub fn executable_folder(&self) -> PathBuf {
        match self {
            Self::MacBundle(contents) => contents.join("MacOS"),
            Self::WindowsFolder(folder) => folder.clone(),
        }
    }

    /// `Contents/Resources` in a bundle.
    pub fn resources(&self) -> PathBuf {
        match self {
            Self::MacBundle(contents) => contents.join("Resources"),
            Self::WindowsFolder(folder) => folder.clone(),
        }
    }

    /// Where libmpv and libvips are, with the libraries they need.
    pub fn libraries(&self) -> PathBuf {
        match self {
            Self::MacBundle(contents) => contents.join("Frameworks"),
            Self::WindowsFolder(folder) => folder.clone(),
        }
    }

    /// Where libavif is. On Windows it has a folder of its own, since MSYS2's build brings a dozen
    /// DLLs that load from beside it.
    pub fn libavif(&self) -> PathBuf {
        match self {
            Self::MacBundle(_) => self.libraries(),
            Self::WindowsFolder(folder) => folder.join("libavif"),
        }
    }

    /// The pinned ffmpeg and ffprobe.
    pub fn media_tools(&self) -> PathBuf {
        self.resources().join("media-tools")
    }

    /// The licence notices, one folder each, listed in [`NOTICE_INDEX_FILE`].
    pub fn licenses(&self) -> PathBuf {
        self.resources().join("licenses")
    }
}

/// `apps/oriel`, the Cargo workspace, found from this crate's folder at compile time.
pub fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/core-paths sits two folders under the workspace")
        .to_path_buf()
}

/// `apps/oriel/.vendor`, the prebuilt libraries `xtask vendor` fetches, one folder per set.
pub fn vendor_root() -> PathBuf {
    workspace().join(".vendor")
}

/// `apps/oriel/.libmpv`, the LGPL libmpv sets `xtask libmpv` builds.
pub fn libmpv_root() -> PathBuf {
    workspace().join(".libmpv")
}

/// `apps/oriel/.media-tools`, the pinned ffmpeg and ffprobe `xtask fetch-media-tools` fetches,
/// one folder per platform.
pub fn media_tools_cache() -> PathBuf {
    workspace().join(".media-tools")
}

/// The vendored set `name`, as `.vendor/<name>/current` points at its newest build.
pub fn vendored_set(name: &str) -> PathBuf {
    vendor_root().join(name).join(CURRENT)
}

/// The vendored Windows libavif, `.vendor/libavif-windows`, laid out as the package's
/// `libavif` folder.
pub fn vendored_libavif_windows() -> PathBuf {
    vendor_root().join("libavif-windows")
}
