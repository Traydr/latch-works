//! Finding ffmpeg and ffprobe at run time, by `NativeSet::MEDIA_TOOLS`'s search. Never on
//! `PATH`: a Homebrew ffmpeg is another build, with another SVT-AV1 and other codecs, so it runs
//! only when someone names it.

use std::fmt;
use std::path::{Path, PathBuf};

use oriel_core_paths::{
    MEDIA_TOOLS_VERSION, MediaToolsMarker, NativeSet, NativeSource, Places, media_tools_files,
    media_tools_platform,
};

/// The ffmpeg and ffprobe this process runs.
#[derive(Clone, Debug)]
pub struct MediaTools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    source: NativeSource,
}

impl MediaTools {
    /// Finds the tools: the package's, the folder `ORIEL_MEDIA_TOOLS` names, or the development
    /// cache when it holds this build's pin.
    pub fn locate() -> Result<Self, LocateError> {
        Self::locate_in(&Places::of_this_process(&NativeSet::MEDIA_TOOLS))
    }

    fn locate_in(places: &Places) -> Result<Self, LocateError> {
        let found = NativeSet::MEDIA_TOOLS
            .locate_in(places)
            .map_err(|error| match error {
                oriel_core_paths::LocateError::NotInDevelopment { folder, .. } => {
                    LocateError::NotFetched { folder }
                }
                other => LocateError::Elsewhere(other),
            })?;
        if found.source == NativeSource::Development {
            match MediaToolsMarker::read(&found.path) {
                None => return Err(LocateError::NotFetched { folder: found.path }),
                Some(marker) if marker.version != MEDIA_TOOLS_VERSION => {
                    return Err(LocateError::Stale {
                        folder: found.path,
                        found: marker.version,
                    });
                }
                Some(_) => {}
            }
        }
        Ok(Self::in_folder(&found.path, found.source))
    }

    fn in_folder(folder: &Path, source: NativeSource) -> Self {
        let [ffmpeg, ffprobe] =
            media_tools_files(&media_tools_platform()).map(|file| folder.join(file));
        Self {
            ffmpeg,
            ffprobe,
            source,
        }
    }

    pub fn ffmpeg(&self) -> &Path {
        &self.ffmpeg
    }

    pub fn ffprobe(&self) -> &Path {
        &self.ffprobe
    }

    pub fn source(&self) -> NativeSource {
        self.source
    }
}

/// Why no tools were found.
#[derive(Debug)]
pub enum LocateError {
    /// The development cache has not been filled.
    NotFetched { folder: PathBuf },
    /// The development cache holds another pin's build.
    Stale { folder: PathBuf, found: String },
    /// The package lacks them, or the variable names a folder without them.
    Elsewhere(oriel_core_paths::LocateError),
}

impl fmt::Display for LocateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let fetch = NativeSet::MEDIA_TOOLS.fetch;
        match self {
            Self::NotFetched { folder } => write!(
                f,
                "the pinned ffmpeg is not in {}; run `{fetch}` in apps/oriel",
                folder.display()
            ),
            Self::Stale { folder, found } => write!(
                f,
                "{} holds ffmpeg {found}, not the pinned {MEDIA_TOOLS_VERSION}; run `{fetch}` in \
                 apps/oriel",
                folder.display()
            ),
            Self::Elsewhere(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for LocateError {}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn a_dev_build_runs_the_cached_pin_and_refuses_another() {
        let root = std::env::temp_dir()
            .join("oriel-tools-locate-tests")
            .join(std::process::id().to_string());
        let _ = fs::remove_dir_all(&root);
        let cache = root.join(".media-tools").join(media_tools_platform());
        let places = Places {
            package: None,
            variable: None,
            development: cache.clone(),
            fallback: None,
        };
        let error = MediaTools::locate_in(&places).unwrap_err();
        assert!(matches!(error, LocateError::NotFetched { .. }), "{error}");
        assert!(error.to_string().contains(NativeSet::MEDIA_TOOLS.fetch));

        fs::create_dir_all(&cache).unwrap();
        for file in media_tools_files(&media_tools_platform()) {
            fs::write(cache.join(file), b"").unwrap();
        }
        let marker = |version: &str| {
            let marker = MediaToolsMarker {
                version: version.to_owned(),
                archives: Vec::new(),
                ffmpeg: String::new(),
                ffprobe: String::new(),
            };
            fs::write(
                cache.join(MediaToolsMarker::FILE),
                serde_json::to_string(&marker).unwrap(),
            )
            .unwrap();
        };
        marker("8.1");
        let error = MediaTools::locate_in(&places).unwrap_err();
        assert!(matches!(error, LocateError::Stale { .. }), "{error}");

        marker(MEDIA_TOOLS_VERSION);
        let tools = MediaTools::locate_in(&places).unwrap();
        assert_eq!(tools.source(), NativeSource::Development);
        assert!(tools.ffprobe().starts_with(&cache));
        fs::remove_dir_all(&root).unwrap();
    }
}
