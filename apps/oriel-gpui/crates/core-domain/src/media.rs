//! The media types from `media-domain`'s `media.ts`, as they are ported.

use serde::{Deserialize, Serialize};

/// How the gallery orders its items. The serde names are the TypeScript ones, which View's
/// settings file stores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GallerySortMode {
    NameAsc,
    NameDesc,
    DateNewest,
    DateOldest,
    Random,
}
