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

use std::cmp::{Ordering, Reverse};
use std::sync::LazyLock;

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
    compare_names_then_paths((a.name(), a.path()), (b.name(), b.path()))
}

/// Below this many items, sorting through the collator is as quick as making sort keys first.
const KEYED_FROM: usize = 256;

/// From this many items on, the keys are made and checked on several threads.
const SHARED_FROM: usize = 16_384;

/// The most threads the keys are made and checked on.
const MAX_THREADS: usize = 8;

/// Where each item falls in natural order, as [`compare_by_name`] orders them: item `i` comes
/// before item `j` exactly when `ranks[i] < ranks[j]`, and items that compare equal share a rank.
///
/// Comparing ranks answers every comparison as [`compare_by_name`] would, so a list ranked once
/// sorts again either way round, or by another column with the names breaking ties, without the
/// collator, and a sort by rank lands every item where a sort through the collator would.
///
/// A long list is ordered by the collator's sort keys, which are made once per item and compared
/// as bytes, then checked pair by pair against the collator itself; if the keys ever disagreed
/// with it, the list is sorted through the collator instead, so the ranks are always its order.
/// A very long list makes and checks its keys on several threads.
pub fn name_ranks<T: NamedPath>(items: &[T]) -> Vec<u32> {
    let count = u32::try_from(items.len()).expect("a list ranked by name fits in u32");
    let names: Vec<&str> = items.iter().map(NamedPath::name).collect();
    let paths: Vec<&str> = items.iter().map(NamedPath::path).collect();
    let compare = |a: u32, b: u32| {
        let (a, b) = (a as usize, b as usize);
        compare_names_then_paths((names[a], paths[a]), (names[b], paths[b]))
    };
    if items.len() >= KEYED_FROM {
        let threads = threads_for(items.len());
        let keys = SortKeys::of(&names, threads);
        let mut order: Vec<u32> = (0..count).collect();
        keys.sort(&mut order);
        order_ties_by_path(&mut order, &keys, &paths);
        if let Some(ranks) = ranks_in(&order, &compare, threads) {
            return ranks;
        }
    }
    let mut order: Vec<u32> = (0..count).collect();
    order.sort_by(|a, b| compare(*a, *b));
    // A sort through the collator is in the collator's order, so this never falls through.
    ranks_in(&order, &compare, 1).unwrap_or_else(|| {
        let mut ranks = vec![0; order.len()];
        for (rank, index) in order.iter().enumerate() {
            ranks[*index as usize] = rank as u32;
        }
        ranks
    })
}

/// Orders each run of `order` whose names share a key by path, as [`compare_by_name`] breaks
/// their ties: through the paths' own sort keys when there are many such items, as in a list
/// sorted by folder, where most items share theirs with others.
fn order_ties_by_path(order: &mut [u32], keys: &SortKeys, paths: &[&str]) {
    let mut ties = Vec::new();
    let mut start = 0;
    for end in 1..=order.len() {
        if end == order.len() || keys.get(order[end]) != keys.get(order[start]) {
            if end - start > 1 {
                ties.push(start..end);
            }
            start = end;
        }
    }
    let tied: usize = ties.iter().map(ExactSizeIterator::len).sum();
    if tied < KEYED_FROM {
        for run in ties {
            order[run]
                .sort_by(|a, b| NAME_COLLATOR.compare(paths[*a as usize], paths[*b as usize]));
        }
        return;
    }
    let members: Vec<u32> = ties
        .iter()
        .flat_map(|run| order[run.clone()].iter().copied())
        .collect();
    let member_paths: Vec<&str> = members.iter().map(|index| paths[*index as usize]).collect();
    let path_keys = SortKeys::of(&member_paths, threads_for(members.len()));
    let mut slot = vec![0; paths.len()];
    for (at, index) in members.iter().enumerate() {
        slot[*index as usize] = at as u32;
    }
    for run in ties {
        let run = &mut order[run];
        let mut slots: Vec<u32> = run.iter().map(|index| slot[*index as usize]).collect();
        path_keys.sort(&mut slots);
        for (index, at) in run.iter_mut().zip(slots) {
            *index = members[at as usize];
        }
    }
}

/// [`compare_by_name`] on a name and a path each.
fn compare_names_then_paths(a: (&str, &str), b: (&str, &str)) -> Ordering {
    NAME_COLLATOR
        .compare(a.0, b.0)
        .then_with(|| NAME_COLLATOR.compare(a.1, b.1))
}

/// The threads to rank `count` items on.
fn threads_for(count: usize) -> usize {
    if count < SHARED_FROM {
        return 1;
    }
    std::thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, MAX_THREADS)
}

/// Splits `0..count` into `parts` runs of about the same length.
fn runs(count: usize, parts: usize) -> impl Iterator<Item = std::ops::Range<usize>> {
    let length = count.div_ceil(parts.max(1)).max(1);
    (0..count)
        .step_by(length)
        .map(move |start| start..(start + length).min(count))
}

/// The ranks of the items `order` lists, if it lists them in `compare`'s order: one more at each
/// step forward, the same between items that compare equal. `None` if any item comes after one
/// it should precede. The pairs are compared on `threads` threads.
fn ranks_in(
    order: &[u32],
    compare: &(impl Fn(u32, u32) -> Ordering + Sync),
    threads: usize,
) -> Option<Vec<u32>> {
    let pairs = order.len().saturating_sub(1);
    let steps: Vec<Ordering> = if threads > 1 {
        std::thread::scope(|scope| {
            let parts: Vec<_> = runs(pairs, threads)
                .map(|run| {
                    scope.spawn(move || {
                        run.map(|at| compare(order[at], order[at + 1]))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            parts
                .into_iter()
                .flat_map(|part| part.join().expect("comparing names does not panic"))
                .collect()
        })
    } else {
        order
            .windows(2)
            .map(|pair| compare(pair[0], pair[1]))
            .collect()
    };
    let mut ranks = vec![0; order.len()];
    let mut rank = 0;
    for (at, step) in steps.into_iter().enumerate() {
        match step {
            Ordering::Less => rank += 1,
            Ordering::Equal => {}
            Ordering::Greater => return None,
        }
        ranks[order[at + 1] as usize] = rank;
    }
    Some(ranks)
}

/// The collator's sort key of each name, end to end in one buffer.
struct SortKeys {
    bytes: Vec<u8>,
    ends: Vec<usize>,
}

impl SortKeys {
    /// The keys of `names`, made on `threads` threads.
    fn of(names: &[&str], threads: usize) -> Self {
        if threads <= 1 {
            return Self::of_run(names);
        }
        let parts: Vec<SortKeys> = std::thread::scope(|scope| {
            let parts: Vec<_> = runs(names.len(), threads)
                .map(|run| scope.spawn(move || Self::of_run(&names[run])))
                .collect();
            parts
                .into_iter()
                .map(|part| part.join().expect("making sort keys does not panic"))
                .collect()
        });
        let mut keys = Self {
            bytes: Vec::with_capacity(parts.iter().map(|part| part.bytes.len()).sum()),
            ends: Vec::with_capacity(names.len()),
        };
        for part in parts {
            let offset = keys.bytes.len();
            keys.bytes.extend_from_slice(&part.bytes);
            keys.ends.extend(part.ends.iter().map(|end| end + offset));
        }
        keys
    }

    fn of_run(names: &[&str]) -> Self {
        let mut bytes = Vec::with_capacity(names.len() * 16);
        let mut ends = Vec::with_capacity(names.len());
        for name in names {
            let Ok(()) = NAME_COLLATOR.write_sort_key_to(name, &mut bytes);
            ends.push(bytes.len());
        }
        Self { bytes, ends }
    }

    fn get(&self, index: u32) -> &[u8] {
        let index = index as usize;
        let start = index.checked_sub(1).map_or(0, |before| self.ends[before]);
        &self.bytes[start..self.ends[index]]
    }

    /// The first 16 bytes of a key, as a number that orders as they do, short keys padded with
    /// zeros. Two keys whose heads differ order as their heads do; heads that tie say nothing.
    fn head(&self, index: u32) -> u128 {
        let key = self.get(index);
        let mut head = [0; 16];
        let length = key.len().min(16);
        head[..length].copy_from_slice(&key[..length]);
        u128::from_be_bytes(head)
    }

    /// Sorts `order`, indices of these keys, by key; keys that tie come by index, as a stable
    /// sort of indices listed in order leaves them. The keys' heads are compared first, side by
    /// side in one list, and the keys themselves only when their heads tie.
    fn sort(&self, order: &mut [u32]) {
        let mut heads: Vec<(u128, u32)> = order
            .iter()
            .map(|index| (self.head(*index), *index))
            .collect();
        heads.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| self.get(a.1).cmp(self.get(b.1)))
                .then(a.1.cmp(&b.1))
        });
        for (index, (_, sorted)) in order.iter_mut().zip(heads) {
            *index = sorted;
        }
    }
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
    let by_name = matches!(mode, GallerySortMode::NameAsc | GallerySortMode::NameDesc);
    if by_name && items.len() >= KEYED_FROM {
        return sort_ranked(items, mode);
    }
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

/// [`sort_media_items`] by name for a long list: each item's [`name_ranks`] rank in place of the
/// collator, so every comparison answers as it would and every item lands where it would. Random
/// and the date orders keep the collator, since there names only break ties, which are rare, and
/// ranking every item costs more than comparing the few.
fn sort_ranked<T: SortableMediaItem>(items: Vec<T>, mode: GallerySortMode) -> Vec<T> {
    let ranks = name_ranks(&items);
    let mut ranked: Vec<(u32, T)> = ranks.into_iter().zip(items).collect();
    if mode == GallerySortMode::NameDesc {
        ranked.sort_by_key(|(rank, _)| Reverse(*rank));
    } else {
        ranked.sort_by_key(|(rank, _)| *rank);
    }
    ranked.into_iter().map(|(_, item)| item).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The keys and the checks shared between threads come out as made on one.
    #[test]
    fn threads_rank_as_one_does() {
        let names: Vec<String> = (0..1_000)
            .map(|index| {
                format!(
                    "{} {}.jpg",
                    ["IMG_", "img", "\u{C9}t\u{E9}"][index % 3],
                    index % 70
                )
            })
            .collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let one = SortKeys::of(&names, 1);
        let shared = SortKeys::of(&names, 4);
        assert_eq!((&one.bytes, &one.ends), (&shared.bytes, &shared.ends));

        let compare = |a: u32, b: u32| NAME_COLLATOR.compare(names[a as usize], names[b as usize]);
        let mut order: Vec<u32> = (0..names.len() as u32).collect();
        order.sort_by(|a, b| compare(*a, *b));
        let ranks = ranks_in(&order, &compare, 1).expect("in the collator's order");
        assert_eq!(ranks_in(&order, &compare, 4), Some(ranks));
        order.swap(0, 999);
        assert_eq!(ranks_in(&order, &compare, 4), None);
    }
}
