//! The licence notices a package carries ([`Package::licenses`](crate::Package::licenses)): one
//! folder each for Oriel, every library set, ffmpeg and ffprobe, and the Rust crates, listed in
//! [`NOTICE_INDEX_FILE`]. xtask writes the index and the About dialog reads it.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::layout::NOTICE_INDEX_FILE;

/// One folder of notices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    /// The folder under `licenses/`.
    pub folder: String,
    pub name: String,
    /// The version or set id.
    pub version: String,
    /// An SPDX expression, or a short phrase where there are many.
    pub licence: String,
}

/// What [`NOTICE_INDEX_FILE`] holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeIndex {
    pub app: String,
    pub version: String,
    pub notices: Vec<Notice>,
}

impl NoticeIndex {
    /// The index in `licenses`, if it is there and reads.
    pub fn read(licenses: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(licenses.join(NOTICE_INDEX_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }
}
