//! The native libraries and programs the app loads or runs at run time (libvips, libavif,
//! libmpv, ffmpeg and ffprobe), and the one search that finds each:
//!
//! 1. in the package, when the app runs from one ([`Package`]): a packaged app looks nowhere
//!    else, so one packed without a library says so rather than loading a development copy;
//! 2. what the set's variable names, when it is set;
//! 3. the development copy in the workspace, which an xtask command fetches or builds;
//! 4. failing that, the set's development fallback outside the workspace, if it has one.
//!
//! Once one is chosen, failing to load it is the caller's error rather than a fall through, so a
//! broken copy shows instead of another one running in its place.

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::layout::{self, Package};

/// One library or pair of programs the app finds at run time.
#[derive(Debug)]
pub struct NativeSet {
    /// What messages call it.
    pub name: &'static str,
    /// Names the file (or, for [`NativeSet::MEDIA_TOOLS`], the folder) to use instead.
    pub variable: &'static str,
    /// The folder a package keeps it in.
    pub packaged: fn(&Package) -> PathBuf,
    /// The folder development builds find it in.
    pub development: fn() -> PathBuf,
    /// The file a development build loads when the development copy has not been made.
    pub fallback: Option<&'static str>,
    /// What to load in a folder: the library, or the folder itself when it holds the programs.
    pub find: fn(&Path) -> Option<PathBuf>,
    /// Whether the variable names a folder, which must hold what `find` looks for.
    pub variable_names_folder: bool,
    /// The command that makes the development copy, for the message that asks for it.
    pub fetch: &'static str,
}

impl NativeSet {
    /// sharp's own libvips build, the one Tidy's fingerprints were tuned on.
    pub const LIBVIPS: NativeSet = NativeSet {
        name: "libvips",
        variable: "ORIEL_LIBVIPS",
        packaged: Package::libraries,
        development: || layout::vendored_set("libvips").join("lib"),
        fallback: None,
        find: libvips_in,
        variable_names_folder: false,
        fetch: "cargo run -p xtask -- vendor libvips",
    };

    /// libavif with aom, for Convert's AVIF encode.
    pub const LIBAVIF: NativeSet = NativeSet {
        name: "libavif",
        variable: "ORIEL_LIBAVIF",
        packaged: Package::libavif,
        development: || {
            if cfg!(windows) {
                layout::vendored_libavif_windows()
            } else {
                layout::vendored_set("libavif")
            }
        },
        fallback: None,
        find: libavif_in,
        variable_names_folder: false,
        fetch: if cfg!(windows) {
            "cargo run -p xtask -- vendor libavif-windows"
        } else {
            "cargo run -p xtask -- vendor libavif"
        },
    };

    /// The LGPL libmpv set, for video. Without it, a development build on macOS reads IINA's own
    /// libmpv in place. That build is GPL: fine for development, and a package never loads it.
    pub const LIBMPV: NativeSet = NativeSet {
        name: "libmpv",
        variable: "ORIEL_LIBMPV",
        packaged: Package::libraries,
        development: || layout::libmpv_root().join(layout::CURRENT),
        fallback: if cfg!(target_os = "macos") {
            Some("/Applications/IINA.app/Contents/Frameworks/libmpv.2.dylib")
        } else {
            None
        },
        find: libmpv_in,
        variable_names_folder: false,
        fetch: "cargo run -p xtask -- libmpv",
    };

    /// The pinned ffmpeg and ffprobe, run as child processes. Never from `PATH`: a Homebrew
    /// ffmpeg is another build, with another SVT-AV1 and other codecs.
    pub const MEDIA_TOOLS: NativeSet = NativeSet {
        name: "ffmpeg and ffprobe",
        variable: "ORIEL_MEDIA_TOOLS",
        packaged: Package::media_tools,
        development: || layout::media_tools_cache().join(media_tools_platform()),
        fallback: None,
        find: media_tools_in,
        variable_names_folder: true,
        fetch: "cargo run -p xtask -- fetch-media-tools",
    };

    /// Finds the set for this process, by the search the module describes.
    pub fn locate(&'static self) -> Result<Located, LocateError> {
        self.locate_in(&Places::of_this_process(self))
    }

    /// Finds the set in `places`.
    pub fn locate_in(&'static self, places: &Places) -> Result<Located, LocateError> {
        if let Some(package) = &places.package {
            let folder = (self.packaged)(package);
            return (self.find)(&folder)
                .map(|path| Located::new(path, NativeSource::Packaged))
                .ok_or(LocateError::PackagedWithout { set: self, folder });
        }
        if let Some(chosen) = &places.variable {
            let chosen = PathBuf::from(chosen);
            if !self.variable_names_folder {
                return Ok(Located::new(chosen, NativeSource::Variable));
            }
            return (self.find)(&chosen)
                .map(|path| Located::new(path, NativeSource::Variable))
                .ok_or(LocateError::VariableIncomplete {
                    set: self,
                    folder: chosen,
                });
        }
        (self.find)(&places.development)
            .or_else(|| places.fallback.clone().filter(|path| path.is_file()))
            .map(|path| Located::new(path, NativeSource::Development))
            .ok_or_else(|| LocateError::NotInDevelopment {
                set: self,
                folder: places.development.clone(),
            })
    }
}

/// What [`NativeSet::locate_in`] looks at, so tests can stand in for the process's own.
#[derive(Clone, Debug)]
pub struct Places {
    pub package: Option<Package>,
    pub variable: Option<OsString>,
    pub development: PathBuf,
    pub fallback: Option<PathBuf>,
}

impl Places {
    pub fn of_this_process(set: &NativeSet) -> Self {
        Self {
            package: Package::of_running_app(),
            variable: std::env::var_os(set.variable).filter(|value| !value.is_empty()),
            development: (set.development)(),
            fallback: set.fallback.map(PathBuf::from),
        }
    }
}

/// Where a set was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeSource {
    Packaged,
    Variable,
    Development,
}

/// A set found: the file to load, or for [`NativeSet::MEDIA_TOOLS`] the folder holding both
/// programs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub path: PathBuf,
    pub source: NativeSource,
}

impl Located {
    fn new(path: PathBuf, source: NativeSource) -> Self {
        Self { path, source }
    }
}

/// Why a set was not found.
#[derive(Debug)]
pub enum LocateError {
    /// The app was packaged without it.
    PackagedWithout {
        set: &'static NativeSet,
        folder: PathBuf,
    },
    /// The set's variable names a folder without it.
    VariableIncomplete {
        set: &'static NativeSet,
        folder: PathBuf,
    },
    /// The development copy has not been made.
    NotInDevelopment {
        set: &'static NativeSet,
        folder: PathBuf,
    },
}

impl fmt::Display for LocateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PackagedWithout { set, folder } => write!(
                f,
                "the app was packaged without {} in {}",
                set.name,
                folder.display()
            ),
            Self::VariableIncomplete { set, folder } => write!(
                f,
                "{} names {}, which lacks {}",
                set.variable,
                folder.display(),
                set.name
            ),
            Self::NotInDevelopment { set, folder } => write!(
                f,
                "no {} in {}: run `{}` in apps/oriel, or set {} to one",
                set.name,
                folder.display(),
                set.fetch,
                set.variable
            ),
        }
    }
}

impl std::error::Error for LocateError {}

/// The files in `folder` whose names pass `keep`, sorted.
fn names_in(folder: &Path, keep: impl Fn(&str) -> bool) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| keep(name))
        .collect();
    names.sort();
    names
}

/// sharp's `libvips-cpp.<version>.dylib` in `folder`, the newest name first; on Windows, the C
/// API's `libvips-42.dll` that sharp's Windows package carries.
fn libvips_in(folder: &Path) -> Option<PathBuf> {
    names_in(folder, |name| {
        (name.starts_with("libvips-cpp.") && name.ends_with(".dylib"))
            || (cfg!(windows) && name == "libvips-42.dll")
    })
    .into_iter()
    .rev()
    .map(|name| folder.join(name))
    .find(|path| path.is_file())
}

/// libavif 1.x's file in `folder`. On Windows CMake's MSVC build names it `avif.dll` and MinGW's
/// (MSYS2's package) `libavif-16.dll`.
fn libavif_in(folder: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["avif.dll", "libavif-16.dll"]
    } else {
        &["libavif.16.dylib"]
    };
    names
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
}

/// The `libmpv*.dylib` (`libmpv*.dll` on Windows) in `folder`, client API 2's first if there are
/// several: `libmpv.2.dylib`, or `libmpv-2.dll` as shinchiro's Windows builds name it.
fn libmpv_in(folder: &Path) -> Option<PathBuf> {
    let (preferred, extension) = if cfg!(windows) {
        ("libmpv-2.dll", ".dll")
    } else {
        ("libmpv.2.dylib", ".dylib")
    };
    let mut names = names_in(folder, |name| {
        name.starts_with("libmpv") && name.ends_with(extension)
    });
    names.sort_by_key(|name| name != preferred);
    names
        .into_iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
}

/// `folder` when it holds both ffmpeg and ffprobe.
fn media_tools_in(folder: &Path) -> Option<PathBuf> {
    media_tools_files(&media_tools_platform())
        .iter()
        .all(|file| folder.join(file).is_file())
        .then(|| folder.to_path_buf())
}

/// The platform this was built for, as the media tools' pins and cache folders name it
/// (Node's `darwin-arm64`, `win32-x64`).
pub fn media_tools_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// ffmpeg's and ffprobe's file names on `platform`, with `.exe` on Windows.
pub fn media_tools_files(platform: &str) -> [&'static str; 2] {
    if platform.starts_with("win32") {
        ["ffmpeg.exe", "ffprobe.exe"]
    } else {
        ["ffmpeg", "ffprobe"]
    }
}

/// The ffmpeg release the development cache must hold: the version of every platform's pin.
pub const MEDIA_TOOLS_VERSION: &str = "9.0.2";

/// What the development cache records beside the programs, in `pin.json`: the pin's version, the
/// SHA-256 of each archive it was unpacked from, and the unpacked programs' SHA-256, so a re-pinned
/// archive or a changed program is fetched again rather than run.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MediaToolsMarker {
    pub version: String,
    /// Missing from a cache an older xtask filled, which is then fetched again.
    #[serde(default)]
    pub archives: Vec<String>,
    pub ffmpeg: String,
    pub ffprobe: String,
}

impl MediaToolsMarker {
    pub const FILE: &'static str = "pin.json";

    pub fn read(folder: &Path) -> Option<Self> {
        let text = fs::read_to_string(folder.join(Self::FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-paths-native-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn put(path: &Path) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"").unwrap();
        path.to_path_buf()
    }

    #[test]
    fn a_package_looks_only_in_itself_then_the_variable_then_the_development_copy() {
        let root = scratch("order");
        let set = &NativeSet::LIBVIPS;
        let bundle = Package::MacBundle(root.join("Oriel.app/Contents"));
        let mut places = Places {
            package: None,
            variable: None,
            development: root.join("vendor/lib"),
            fallback: None,
        };
        let error = set.locate_in(&places).unwrap_err();
        assert!(error.to_string().contains(set.fetch), "{error}");

        let vendored = put(&root.join("vendor/lib/libvips-cpp.8.18.7.dylib"));
        put(&root.join("vendor/lib/libvips-cpp.8.18.6.dylib"));
        assert_eq!(
            set.locate_in(&places).unwrap(),
            Located::new(vendored, NativeSource::Development)
        );

        places.variable = Some("/elsewhere/libvips.dylib".into());
        assert_eq!(
            set.locate_in(&places).unwrap(),
            Located::new("/elsewhere/libvips.dylib".into(), NativeSource::Variable)
        );

        places.package = Some(bundle.clone());
        assert!(matches!(
            set.locate_in(&places),
            Err(LocateError::PackagedWithout { .. })
        ));
        let bundled = put(&bundle.libraries().join("libvips-cpp.8.18.7.dylib"));
        assert_eq!(
            set.locate_in(&places).unwrap(),
            Located::new(bundled, NativeSource::Packaged)
        );
    }

    /// The licence rule: a package loads its own LGPL libmpv, and never IINA's GPL build, even
    /// with nothing else to load.
    #[test]
    fn a_package_never_loads_the_development_fallback() {
        let root = scratch("fallback");
        let set = &NativeSet::LIBMPV;
        let iina = put(&root.join("IINA.app/Contents/Frameworks/libmpv.2.dylib"));
        let bundle = Package::MacBundle(root.join("Oriel.app/Contents"));
        let mut places = Places {
            package: None,
            variable: None,
            development: root.join(".libmpv/current"),
            fallback: Some(iina.clone()),
        };
        assert_eq!(set.locate_in(&places).unwrap().path, iina);
        let dev = put(&root.join(".libmpv/current").join(if cfg!(windows) {
            "libmpv-2.dll"
        } else {
            "libmpv.2.dylib"
        }));
        assert_eq!(set.locate_in(&places).unwrap().path, dev);

        places.package = Some(bundle.clone());
        assert!(matches!(
            set.locate_in(&places),
            Err(LocateError::PackagedWithout { .. })
        ));
    }

    #[test]
    fn the_media_tools_variable_names_a_folder_holding_both() {
        let root = scratch("tools");
        let set = &NativeSet::MEDIA_TOOLS;
        let chosen = root.join("chosen");
        let [ffmpeg, ffprobe] = media_tools_files(&media_tools_platform());
        put(&chosen.join(ffmpeg));
        let places = Places {
            package: None,
            variable: Some(chosen.clone().into()),
            development: root.join(".media-tools"),
            fallback: None,
        };
        assert!(matches!(
            set.locate_in(&places),
            Err(LocateError::VariableIncomplete { .. })
        ));
        put(&chosen.join(ffprobe));
        assert_eq!(set.locate_in(&places).unwrap().path, chosen);
    }

    #[cfg(not(windows))]
    #[test]
    fn a_bundle_is_known_by_its_executable() {
        let contents = PathBuf::from("/Applications/Oriel.app/Contents");
        assert_eq!(
            Package::of_executable(&contents.join("MacOS/oriel")),
            Some(Package::MacBundle(contents.clone()))
        );
        assert_eq!(
            Package::of_executable(Path::new("/repo/target/debug/oriel")),
            None
        );
        let bundle = Package::MacBundle(contents.clone());
        assert_eq!(bundle.media_tools(), contents.join("Resources/media-tools"));
        assert_eq!(bundle.licenses(), contents.join("Resources/licenses"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_package_is_known_by_its_licence_notices() {
        let folder = scratch("windows-package");
        let executable = folder.join(layout::WINDOWS_EXECUTABLE);
        assert_eq!(Package::of_executable(&executable), None);
        let package = Package::WindowsFolder(folder.clone());
        fs::create_dir_all(package.licenses()).unwrap();
        assert_eq!(Package::of_executable(&executable), Some(package.clone()));
        assert_eq!(package.media_tools(), folder.join("media-tools"));
        assert_eq!(package.libavif(), folder.join("libavif"));
    }
}
