//! Finding ffmpeg and ffprobe at run time. Never on `PATH`: a Homebrew ffmpeg is another build,
//! with another SVT-AV1 and other codecs, so it runs only when someone names it.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::fetch::{FETCH_COMMAND, Marker, dev_cache};
use crate::pins::{current_platform, pin_for, tool_files};

/// Names a folder holding the ffmpeg and ffprobe to run instead of the pinned ones.
pub const OVERRIDE_VARIABLE: &str = "ORIEL_MEDIA_TOOLS";

/// Where a pair of tools was found, for Diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSource {
    /// The folder [`OVERRIDE_VARIABLE`] names.
    Override,
    /// `Contents/Resources/media-tools` in the app bundle this runs from.
    Bundle,
    /// The development cache [`crate::ensure_media_tools`] fills.
    DevCache,
}

/// The ffmpeg and ffprobe this process runs.
#[derive(Clone, Debug)]
pub struct MediaTools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    source: ToolSource,
}

impl MediaTools {
    /// Finds the tools, first match wins:
    ///
    /// 1. the folder [`OVERRIDE_VARIABLE`] names, when it is set, since naming one is deliberate;
    /// 2. the app bundle's `Contents/Resources/media-tools`, when running from an `.app`;
    /// 3. the development cache, when it holds this build's pin.
    ///
    /// A source that applies but lacks the tools is an error, never a fall through to the next: a
    /// mistyped override or a bundle packed without them should show, not run something else.
    pub fn locate() -> Result<Self, LocateError> {
        Self::locate_in(&Places {
            override_folder: std::env::var_os(OVERRIDE_VARIABLE).filter(|value| !value.is_empty()),
            executable: std::env::current_exe().ok(),
            dev_cache: dev_cache(),
            platform: current_platform(),
        })
    }

    fn locate_in(places: &Places) -> Result<Self, LocateError> {
        let platform = &places.platform;
        if let Some(folder) = &places.override_folder {
            let folder = PathBuf::from(folder);
            return Self::in_folder(&folder, platform, ToolSource::Override)
                .ok_or(LocateError::OverrideIncomplete { folder });
        }
        // On Windows the installed app keeps them in `media-tools` beside its executable.
        #[cfg(windows)]
        if let Some(folder) = places
            .executable
            .as_deref()
            .and_then(Path::parent)
            .map(|folder| folder.join("media-tools"))
            && let Some(tools) = Self::in_folder(&folder, platform, ToolSource::Bundle)
        {
            return Ok(tools);
        }
        if let Some(resources) = places.executable.as_deref().and_then(bundle_resources) {
            let folder = resources.join("media-tools");
            return Self::in_folder(&folder, platform, ToolSource::Bundle)
                .ok_or(LocateError::BundleIncomplete { folder });
        }

        let pin = pin_for(platform).ok_or_else(|| LocateError::NoPin {
            platform: platform.clone(),
        })?;
        let folder = places.dev_cache.join(platform);
        let Some(marker) = Marker::read(&folder) else {
            return Err(LocateError::NotFetched { folder });
        };
        if marker.version != pin.version {
            return Err(LocateError::Stale {
                folder,
                found: marker.version,
                pinned: pin.version,
            });
        }
        Self::in_folder(&folder, platform, ToolSource::DevCache)
            .ok_or(LocateError::NotFetched { folder })
    }

    fn in_folder(folder: &Path, platform: &str, source: ToolSource) -> Option<Self> {
        let [ffmpeg, ffprobe] = tool_files(platform).map(|file| folder.join(file));
        (ffmpeg.is_file() && ffprobe.is_file()).then_some(Self {
            ffmpeg,
            ffprobe,
            source,
        })
    }

    pub fn ffmpeg(&self) -> &Path {
        &self.ffmpeg
    }

    pub fn ffprobe(&self) -> &Path {
        &self.ffprobe
    }

    pub fn source(&self) -> ToolSource {
        self.source
    }
}

/// What [`MediaTools::locate_in`] looks at, so tests can stand in for the process's own.
struct Places {
    override_folder: Option<OsString>,
    executable: Option<PathBuf>,
    dev_cache: PathBuf,
    platform: String,
}

/// `X.app/Contents/Resources` when `executable` is `X.app/Contents/MacOS/<name>`.
fn bundle_resources(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents")
        .then(|| contents.join("Resources"))
}

/// Why no tools were found.
#[derive(Debug)]
pub enum LocateError {
    /// [`OVERRIDE_VARIABLE`] names a folder without both tools.
    OverrideIncomplete { folder: PathBuf },
    /// The app bundle was packed without its tools.
    BundleIncomplete { folder: PathBuf },
    /// Nothing is pinned for this platform, so only [`OVERRIDE_VARIABLE`] can name tools.
    NoPin { platform: String },
    /// The development cache has not been filled.
    NotFetched { folder: PathBuf },
    /// The development cache holds another pin's build.
    Stale {
        folder: PathBuf,
        found: String,
        pinned: &'static str,
    },
}

impl fmt::Display for LocateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OverrideIncomplete { folder } => write!(
                f,
                "{OVERRIDE_VARIABLE} names {}, which lacks ffmpeg or ffprobe",
                folder.display()
            ),
            Self::BundleIncomplete { folder } => write!(
                f,
                "the app was packaged without ffmpeg and ffprobe in {}",
                folder.display()
            ),
            Self::NoPin { platform } => write!(
                f,
                "no ffmpeg is pinned for {platform}; name one with {OVERRIDE_VARIABLE}"
            ),
            Self::NotFetched { folder } => write!(
                f,
                "the pinned ffmpeg is not in {}; run `{FETCH_COMMAND}` in apps/oriel",
                folder.display()
            ),
            Self::Stale {
                folder,
                found,
                pinned,
            } => write!(
                f,
                "{} holds ffmpeg {found}, not the pinned {pinned}; run `{FETCH_COMMAND}` in \
                 apps/oriel",
                folder.display()
            ),
        }
    }
}

impl std::error::Error for LocateError {}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-tools-locate-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn put_tools(folder: &Path) {
        fs::create_dir_all(folder).unwrap();
        fs::write(folder.join("ffmpeg"), b"").unwrap();
        fs::write(folder.join("ffprobe"), b"").unwrap();
    }

    /// A development cache holding `version` for darwin-arm64.
    fn dev_cache_with(root: &Path, version: &str) -> PathBuf {
        let cache = root.join(".media-tools");
        put_tools(&cache.join("darwin-arm64"));
        fs::write(
            cache.join("darwin-arm64").join("pin.json"),
            format!(r#"{{"version":"{version}","ffmpeg":"","ffprobe":""}}"#),
        )
        .unwrap();
        cache
    }

    fn places(root: &Path, override_folder: Option<&Path>, executable: &Path) -> Places {
        Places {
            override_folder: override_folder.map(|folder| folder.as_os_str().to_owned()),
            executable: Some(executable.to_owned()),
            dev_cache: root.join(".media-tools"),
            platform: "darwin-arm64".to_owned(),
        }
    }

    #[test]
    fn a_dev_build_runs_the_cached_pin_and_refuses_another() {
        let root = scratch("dev");
        let executable = root.join("target/debug/oriel");
        let error = MediaTools::locate_in(&places(&root, None, &executable)).unwrap_err();
        assert!(matches!(error, LocateError::NotFetched { .. }));
        assert!(error.to_string().contains(FETCH_COMMAND));

        dev_cache_with(&root, "8.1");
        let error = MediaTools::locate_in(&places(&root, None, &executable)).unwrap_err();
        assert!(matches!(error, LocateError::Stale { .. }), "{error}");

        let cache = dev_cache_with(&root, "9.0.2");
        let tools = MediaTools::locate_in(&places(&root, None, &executable)).unwrap();
        assert_eq!(tools.source(), ToolSource::DevCache);
        assert_eq!(tools.ffprobe(), cache.join("darwin-arm64/ffprobe"));
    }

    #[test]
    fn an_app_bundle_runs_its_own_tools_and_never_the_dev_cache() {
        let root = scratch("bundle");
        dev_cache_with(&root, "9.0.2");
        let contents = root.join("Oriel.app/Contents");
        let executable = contents.join("MacOS/oriel");

        let error = MediaTools::locate_in(&places(&root, None, &executable)).unwrap_err();
        assert!(
            matches!(error, LocateError::BundleIncomplete { .. }),
            "{error}"
        );

        put_tools(&contents.join("Resources/media-tools"));
        let tools = MediaTools::locate_in(&places(&root, None, &executable)).unwrap();
        assert_eq!(tools.source(), ToolSource::Bundle);
        assert_eq!(
            tools.ffmpeg(),
            contents.join("Resources/media-tools/ffmpeg")
        );
    }

    #[test]
    fn the_override_wins_and_must_hold_both_tools() {
        let root = scratch("override");
        dev_cache_with(&root, "9.0.2");
        let executable = root.join("target/debug/oriel");
        let chosen = root.join("chosen");
        fs::create_dir_all(&chosen).unwrap();
        fs::write(chosen.join("ffmpeg"), b"").unwrap();

        let error = MediaTools::locate_in(&places(&root, Some(&chosen), &executable)).unwrap_err();
        assert!(
            matches!(error, LocateError::OverrideIncomplete { .. }),
            "{error}"
        );

        put_tools(&chosen);
        let tools = MediaTools::locate_in(&places(&root, Some(&chosen), &executable)).unwrap();
        assert_eq!(tools.source(), ToolSource::Override);
        assert_eq!(tools.ffmpeg(), chosen.join("ffmpeg"));
    }
}
