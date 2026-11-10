//! The one gate for the cases that need Tidy's native tools.

use oriel_core_paths::{LocateError, NativeSet};
use oriel_core_tidy::Media;

/// Tidy's tools as the app finds them: libvips and libavif, and the pinned ffmpeg and ffprobe if
/// fetched (ask `oriel_test_archive::media_tools` for those). Only a development copy of libvips
/// or libavif never made skips, as `oriel_test_archive::require` says; a libvips found that Tidy
/// does not read through fails the test.
pub fn media() -> Option<Media> {
    if let Err(error @ LocateError::NotInDevelopment { .. }) = NativeSet::LIBVIPS.locate() {
        return oriel_test_archive::require("libvips", Err(error));
    }
    oriel_test_archive::libavif()?;
    let media = Media::locate();
    assert!(
        media.loaded_vips().is_some(),
        "Tidy does not read through the libvips found: {media:?}"
    );
    Some(media)
}
