//! `name_ranks` and the sorts built on it answer as `compare_by_name` does: for every pair of a
//! corpus long enough to take the sort keys' path, and for every sort the gallery offers. The
//! corpus is the natural order's vectors (`conformance/media-domain/sort.json`) and names made to
//! stress the collator: digit runs of every length, case and accents, punctuation and spaces,
//! ignorable and combining characters, other scripts' digits, Han and emoji.

use std::{cmp::Ordering, fs, path::Path};

use oriel_core_domain::{
    GallerySortMode, NamedPath, SortableMediaItem, compare_by_name, name_ranks, sort_media_items,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SortVectors {
    natural_order: NaturalOrder,
}

#[derive(Deserialize)]
struct NaturalOrder {
    names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Item {
    id: usize,
    name: String,
    path: String,
    mtime_ms: f64,
}

impl NamedPath for Item {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        &self.path
    }
}

impl SortableMediaItem for Item {
    fn mtime_ms(&self) -> f64 {
        self.mtime_ms
    }
}

const FRAGMENTS: &[&str] = &[
    "a",
    "A",
    "\u{E1}",
    "\u{C1}",
    "a\u{301}",
    "b",
    "z",
    "Z",
    "\u{E4}",
    "\u{E6}",
    "\u{DF}",
    "ss",
    "0",
    "00",
    "1",
    "01",
    "001",
    "9",
    "10",
    "007",
    "42",
    "\u{663}",
    "\u{969}",
    "\u{FF13}",
    "\u{BD}",
    " ",
    "  ",
    "-",
    "_",
    ".",
    ",",
    "(",
    ")",
    "~",
    "\u{AD}",
    "\u{200D}",
    "\u{301}",
    "\u{4E2D}",
    "\u{6587}",
    "\u{20000}",
    "\u{D55C}",
    "\u{AC00}",
    "\u{1F600}",
    "\u{1F1F1}\u{1F1F9}",
    "\u{1C5}",
    "\u{3A9}",
    "\u{3C9}",
    "\u{451}",
    "\u{435}",
    "\u{FB01}",
    "fi",
    "\u{2163}",
    "IMG_",
    "photo ",
    ".jpg",
    ".JPG",
    ".avif",
];

/// Names made from [`FRAGMENTS`] and digit runs, the same every run.
fn stress_names(count: usize) -> Vec<String> {
    let mut seed: u64 = 0x0063_5eed;
    let mut next = move || {
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        seed.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    (0..count)
        .map(|_| {
            let parts = 1 + next() % 5;
            (0..parts)
                .map(|_| match next() % 8 {
                    // Digit runs past the collator's 254-digit chunks too.
                    0 => {
                        let length = [1, 2, 3, 12, 30, 253, 254, 255, 300][(next() % 9) as usize];
                        let digit = char::from(b'0' + (next() % 10) as u8);
                        let lead = if next() % 3 == 0 { "0" } else { "" };
                        format!("{lead}{}", digit.to_string().repeat(length))
                    }
                    _ => FRAGMENTS[(next() % FRAGMENTS.len() as u64) as usize].to_owned(),
                })
                .collect()
        })
        .collect()
}

/// The vectors' names and the stress names, each in a few folders, some of them twice over, so
/// equal names are told apart by their paths and some items are equal outright.
fn corpus() -> Vec<Item> {
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/media-domain/sort.json");
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    let vectors: SortVectors = serde_json::from_str(&json).expect("the vectors parse");
    let names = vectors
        .natural_order
        .names
        .into_iter()
        .chain(stress_names(2_000));
    let mut items = Vec::new();
    for (index, name) in names.enumerate() {
        let folders: &[&str] = match index % 4 {
            0 => &["", "Roll 2/", "Roll 10/"],
            1 => &["roll 2/", "roll 2/"],
            _ => &[""],
        };
        for folder in folders {
            items.push(Item {
                id: items.len(),
                path: format!("{folder}{name}"),
                name: name.clone(),
                mtime_ms: [0., 1_600_000_000_000., 1_700_000_000_000.5][index % 3],
            });
        }
    }
    items
}

#[test]
fn ranks_answer_every_pair_as_the_collator_does() {
    let items = corpus();
    assert!(items.len() > 1_000, "the corpus takes the sort keys' path");
    let ranks = name_ranks(&items);
    // Along the collator's own order the ranks must step up exactly where it does. The order is
    // transitive, so that settles every pair, not only the neighbours.
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|a, b| compare_by_name(&items[*a], &items[*b]));
    let mut differences = Vec::new();
    for pair in order.windows(2) {
        let (a, b) = (&items[pair[0]], &items[pair[1]]);
        let expected = compare_by_name(a, b);
        let actual = ranks[pair[0]].cmp(&ranks[pair[1]]);
        if actual != expected {
            differences.push(format!(
                "{:?} ({:?}) against {:?} ({:?}): collator {expected:?}, ranks {actual:?}",
                a.name, a.path, b.name, b.path
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} neighbours differ:\n{}",
        differences.len(),
        differences[..differences.len().min(20)].join("\n")
    );
}

#[test]
fn long_lists_sort_as_the_collator_sorts_them_in_every_mode() {
    let items = corpus();
    let compare_dates = |a: &Item, b: &Item| {
        a.mtime_ms
            .partial_cmp(&b.mtime_ms)
            .unwrap_or(Ordering::Equal)
    };
    for mode in [
        GallerySortMode::NameAsc,
        GallerySortMode::NameDesc,
        GallerySortMode::DateNewest,
        GallerySortMode::DateOldest,
    ] {
        let mut expected = items.clone();
        match mode {
            GallerySortMode::NameAsc => expected.sort_by(compare_by_name),
            GallerySortMode::NameDesc => expected.sort_by(|a, b| compare_by_name(b, a)),
            GallerySortMode::DateNewest => {
                expected.sort_by(|a, b| compare_dates(b, a).then_with(|| compare_by_name(a, b)))
            }
            _ => expected.sort_by(|a, b| compare_dates(a, b).then_with(|| compare_by_name(a, b))),
        }
        let ids = |list: &[Item]| list.iter().map(|item| item.id).collect::<Vec<_>>();
        let sorted = sort_media_items(items.clone(), mode, 0);
        assert_eq!(ids(&sorted), ids(&expected), "{mode:?}");
    }
}
