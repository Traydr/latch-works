//! The scan's pure parts: naming formats from bytes and walking a root.

pub mod sniff;
pub mod walk;

pub use sniff::{is_extension_mismatch, kind_for_format, preferred_extension, sniff_file};
pub use walk::{WalkedFile, dir_of, extension_of, name_of, walk_root, whole_ms};
