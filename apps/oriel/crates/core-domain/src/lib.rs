//! `media-domain` in Rust: the rules Oriel and Pane View share about media, so the two apps agree
//! on them, and the text and number rules every Oriel mode writes with.
//!
//! Each shared rule is checked against conformance vectors that the TypeScript makes, in
//! `apps/oriel/conformance/media-domain/`, so a change on either side fails a test. The functions
//! keep the TypeScript's names, so each can be found in both. The gallery's entries and comics
//! are View's alone now: their vectors are frozen Rust fixtures.

mod browser_entries;
pub mod collation;
mod comics;
pub mod format;
mod media;
pub mod number;
mod paths;
mod sort;
mod system_files;

pub use browser_entries::{
    BrowserEntry, BrowserListing, MEDIA_KEY_PREFIX, build_browser_entries, folder_key, media_key,
};
pub use comics::{
    ArchiveComicPaths, ComicEntry, ComicMediaItem, ComicOptions, ComicPathAdapter,
    build_comic_entries, sort_comic_entries,
};
pub use media::{
    EXTRA_IMAGE_EXTENSIONS, FolderNode, GallerySortMode, IMAGE_EXTENSIONS, MediaItem, MediaType,
    PDF_EXTENSIONS, VIDEO_EXTENSIONS, detect_media_type, get_extension, is_supported_media_file,
    shown_extensions,
};
pub use paths::{
    canonicalize_extension, display_name_from_path, get_base_name, get_parent_path,
    join_archive_path, normalize_path_for_compare, normalize_path_for_compare_keeping_extensions,
    pair_sync_paths, to_archive_path, trim_trailing_slash,
};
pub use sort::{
    NamedPath, SortableMediaItem, compare_by_name, hash_string, name_ranks, sort_media_items,
};
pub use system_files::{
    GLAZIER_HOLDING_DIRECTORY_NAME, LATCH_WORKS_DIRECTORY_NAME, is_folder_system_file,
    is_system_junk_directory, is_system_junk_file,
};
