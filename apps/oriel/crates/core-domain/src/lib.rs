//! `media-domain` in Rust: the rules Electron Oriel and Pane View share about media, so the two
//! apps agree on them.
//!
//! The TypeScript package stays, since Pane View, the Lockstep CLI and Gather Box use it. Each
//! rule ported here is checked against conformance vectors that the TypeScript makes, in
//! `apps/oriel/conformance/media-domain/`, so a change on either side fails a test (plan 063,
//! "Keeping two implementations honest"). The functions keep the TypeScript's names, so each can
//! be found in both.

mod browser_entries;
mod comics;
mod media;
mod number;
mod paths;
mod sort;
mod system_files;

pub use browser_entries::{BrowserEntry, BrowserListing, build_browser_entries};
pub use comics::{
    ArchiveComicPaths, ComicEntry, ComicMediaItem, ComicOptions, ComicPathAdapter,
    build_comic_entries, sort_comic_entries,
};
pub use media::{
    FolderNode, GallerySortMode, IMAGE_EXTENSIONS, MediaItem, MediaType, PDF_EXTENSIONS,
    VIDEO_EXTENSIONS, detect_media_type, get_extension, is_supported_media_file,
};
pub use paths::{
    canonicalize_extension, display_name_from_path, format_bytes, get_base_name, get_parent_path,
    join_archive_path, normalize_path_for_compare, normalize_path_for_compare_keeping_extensions,
    pair_sync_paths, to_archive_path, trim_trailing_slash,
};
pub use sort::{
    NamedPath, SortableMediaItem, compare_by_name, hash_string, name_ranks, sort_media_items,
};
pub use system_files::{
    GLAZIER_HOLDING_DIRECTORY_NAME, LATCH_WORKS_DIRECTORY_NAME, is_system_junk_directory,
    is_system_junk_file,
};
