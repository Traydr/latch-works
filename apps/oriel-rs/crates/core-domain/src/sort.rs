//! Natural order and the gallery's sort orders, ported from `media-domain`'s `sort.ts`.
//!
//! The TypeScript compares names with `Intl.Collator(undefined, { numeric: true, sensitivity:
//! "base" })`. Runs of decimal digits compare by their value, and only base letters count, so
//! case, accents and width do not. Here the same rule is ICU4X's collator, numeric and at primary
//! strength, which is what `sensitivity: "base"` asks of ICU4C.
//!
//! `undefined` is the app's locale, which Electron Oriel takes from the system's languages. CLDR
//! collates English by the root order, which is the order used here. A user whose first language
//! has its own collation (Lithuanian puts `č` after `c`, Swedish `å` after `z`) gets that order in
//! Electron Oriel; following them is later work.
//!
//! Han ideographs from different blocks follow Chromium's ICU, which Electron Oriel sorts with,
//! rather than Node's. ICU4X's compiled data orders the blocks and then code points, as
//! Chromium's does, where Node's orders all Han by radical and stroke. The conformance test lists
//! the pairs this changes.

use std::{cmp::Ordering, sync::LazyLock};

use icu_collator::{
    CollatorBorrowed, CollatorPreferences,
    options::{CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
};

use crate::GallerySortMode;

/// Something with a display name and a path, which [`compare_by_name`] orders.
pub trait NamedPath {
    fn name(&self) -> &str;
    fn path(&self) -> &str;
}

/// An item the gallery sorts: a name, a path, and when it was last modified, in milliseconds
/// since the epoch with a fraction, as `fs.stat`'s `mtimeMs` gives it.
pub trait SortableMediaItem: NamedPath {
    fn mtime_ms(&self) -> f64;
}

impl<T: NamedPath + ?Sized> NamedPath for &T {
    fn name(&self) -> &str {
        (**self).name()
    }

    fn path(&self) -> &str {
        (**self).path()
    }
}

impl<T: SortableMediaItem + ?Sized> SortableMediaItem for &T {
    fn mtime_ms(&self) -> f64 {
        (**self).mtime_ms()
    }
}

/// The root collator, numeric, at primary strength. The other options stay at the locale's
/// defaults, as the TypeScript leaves them: punctuation and spaces count, and case is not a
/// level of its own.
static NAME_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut preferences = CollatorPreferences::default();
    preferences.numeric_ordering = Some(CollationNumericOrdering::True);
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Primary);
    CollatorBorrowed::try_new(preferences, options)
        .expect("the compiled collation data has the root locale")
});

/// Orders by name in natural order, then by path in the same order when the names are equal.
///
/// Names that are equal in natural order ("Photo.jpg" and "photo.jpg") are told apart by their
/// paths. Items whose paths are equal too compare equal, so a stable sort keeps them in the order
/// they came in.
pub fn compare_by_name<T: NamedPath + ?Sized>(a: &T, b: &T) -> Ordering {
    NAME_COLLATOR
        .compare(a.name(), b.name())
        .then_with(|| NAME_COLLATOR.compare(a.path(), b.path()))
}

/// Orders two names in natural order alone, as `localeCompare` with the same options does, which
/// is how the gallery sorts folders.
pub(crate) fn compare_names(a: &str, b: &str) -> Ordering {
    NAME_COLLATOR.compare(a, b)
}

const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

/// FNV-1a over the UTF-16 code units of `value`, as the TypeScript hashes a JavaScript string with
/// `charCodeAt`. The random order is built on it, so a seed orders a folder the same in both
/// apps.
pub fn hash_string(value: &str) -> u32 {
    continue_hash(FNV_OFFSET_BASIS, value)
}

/// FNV-1a carries all its state in the hash, so a hash of a prefix can be continued over the rest.
fn continue_hash(hash: u32, value: &str) -> u32 {
    value.encode_utf16().fold(hash, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(FNV_PRIME)
    })
}

/// Sorts the gallery's items for `mode`.
///
/// `seed` picks the random order, and the other modes ignore it. View's settings accept any
/// integer for it (`createRandomSeed` makes a `u32`); `i64` holds every safe JavaScript integer
/// and prints it as JavaScript does, so the scores match.
///
/// The sort is stable, as `Array.prototype.sort` is, so items that compare equal keep their order
/// in `items`. As in the TypeScript, `NameDesc` reverses the comparison rather than the result, so
/// such items are not reversed either.
pub fn sort_media_items<T: SortableMediaItem>(
    mut items: Vec<T>,
    mode: GallerySortMode,
    seed: i64,
) -> Vec<T> {
    match mode {
        GallerySortMode::Random => return random_order(items, seed),
        GallerySortMode::NameAsc => items.sort_by(|a, b| compare_by_name(a, b)),
        GallerySortMode::NameDesc => items.sort_by(|a, b| compare_by_name(b, a)),
        GallerySortMode::DateNewest => {
            items.sort_by(|a, b| compare_dates(b, a).then_with(|| compare_by_name(a, b)));
        }
        GallerySortMode::DateOldest => {
            items.sort_by(|a, b| compare_dates(a, b).then_with(|| compare_by_name(a, b)));
        }
    }
    items
}

/// The sign of the TypeScript's `a.mtimeMs - b.mtimeMs`. For finite times, which `fs.stat` gives,
/// the difference is zero exactly when the times are equal, so this is the same order. A NaN,
/// which the TypeScript's sort would treat inconsistently, compares equal.
fn compare_dates<T: SortableMediaItem>(a: &T, b: &T) -> Ordering {
    a.mtime_ms()
        .partial_cmp(&b.mtime_ms())
        .unwrap_or(Ordering::Equal)
}

/// Orders by the hash of `"{seed}:{path}"`, then by name. Each item is hashed once, before the
/// sort, as the TypeScript scores them.
fn random_order<T: SortableMediaItem>(items: Vec<T>, seed: i64) -> Vec<T> {
    let prefix = hash_string(&format!("{seed}:"));
    let mut scored: Vec<(u32, T)> = items
        .into_iter()
        .map(|item| (continue_hash(prefix, item.path()), item))
        .collect();
    scored.sort_by(|(a_score, a), (b_score, b)| {
        a_score.cmp(b_score).then_with(|| compare_by_name(a, b))
    });
    scored.into_iter().map(|(_, item)| item).collect()
}
