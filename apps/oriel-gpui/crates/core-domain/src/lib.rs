//! `media-domain` in Rust: the rules Electron Oriel and Pane View share about media, so the two
//! apps agree on them.
//!
//! The TypeScript package stays, since Pane View, the Lockstep CLI and Gather Box use it. Each
//! rule ported here is checked against conformance vectors that the TypeScript makes, in
//! `apps/oriel-gpui/conformance/media-domain/`, so a change on either side fails a test (plan 063,
//! "Keeping two implementations honest").

mod media;
mod sort;

pub use media::GallerySortMode;
pub use sort::{NamedPath, SortableMediaItem, compare_by_name, hash_string, sort_media_items};
