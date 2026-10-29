//! The scan's pure parts: naming formats from bytes and walking a root.

pub mod sniff;
pub mod walk;

pub use sniff::{
    format_extensions, is_extension_mismatch, kind_for_format, preferred_extension, sniff_bytes,
    sniff_file,
};
pub use walk::{WalkSummary, WalkedFile, extension_of, is_folder_system_file, walk_root, whole_ms};
