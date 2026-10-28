//! The files and folders every scan skips, from `media-domain`'s `system-files.ts`: what macOS
//! and Windows leave beside media, and the Latch Works apps' own folders.

/// Where Latch Works apps keep their own data: `~/.latch-works` for each app's settings, catalogs
/// and caches, and a `.latch-works` folder at the top of another volume for what has to stay on
/// that volume (Glazier's holding, so a removal there is still a rename). Every scanner skips it,
/// so a scan of a home folder or a whole volume neither indexes nor syncs it.
pub const LATCH_WORKS_DIRECTORY_NAME: &str = ".latch-works";

/// Where Glazier held files before they moved under `.latch-works`: inside each root, then at the
/// top of another volume. Still skipped, for archives an older build left them in.
pub const GLAZIER_HOLDING_DIRECTORY_NAME: &str = ".glazier-holding";

const SYSTEM_JUNK_FILE_NAMES: [&str; 5] = [
    ".ds_store",
    "desktop.ini",
    "ehthumbs.db",
    "ehthumbs_vista.db",
    "thumbs.db",
];

const SYSTEM_JUNK_DIRECTORY_NAMES: [&str; 10] = [
    LATCH_WORKS_DIRECTORY_NAME,
    GLAZIER_HOLDING_DIRECTORY_NAME,
    "$recycle.bin",
    ".documentrevisions-v100",
    ".fseventsd",
    ".spotlight-v100",
    ".temporaryitems",
    ".trashes",
    "__macosx",
    "system volume information",
];

/// Whether a file is system clutter: an AppleDouble file (`._` exactly, then anything), or one of
/// `.DS_Store`, `desktop.ini` and the thumbnail caches in any case.
///
/// The name is lowercased by Unicode's full mapping, as JavaScript's `toLowerCase` does, so a
/// dotted capital I does not stand in for an ASCII `i`.
pub fn is_system_junk_file(file_name: &str) -> bool {
    file_name.starts_with("._")
        || SYSTEM_JUNK_FILE_NAMES.contains(&file_name.to_lowercase().as_str())
}

/// Whether a folder is one scans skip, in any case: the Latch Works folders, the Recycle Bin,
/// macOS's volume folders and `__MACOSX`.
pub fn is_system_junk_directory(directory_name: &str) -> bool {
    SYSTEM_JUNK_DIRECTORY_NAMES.contains(&directory_name.to_lowercase().as_str())
}
