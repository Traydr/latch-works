//! Checks the Rust `media-domain` against the vectors the TypeScript makes, in
//! `apps/oriel/conformance/media-domain/sort.json`. They are regenerated from the
//! TypeScript (the file's `about` says how), never by hand, so a failure here is a difference
//! between the two implementations.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use oriel_core_domain::{
    GallerySortMode, NamedPath, SortableMediaItem, compare_by_name, hash_string, sort_media_items,
};
use serde::Deserialize;

/// Pairs of names Rust orders the other way round from the vectors, kept visible here rather than
/// dropped from the corpus. Each is `(a, b)` in the corpus's order.
///
/// All are Han ideographs from different blocks. Node, which makes the vectors, carries ICU4C's
/// full root collation, which orders all Han by radical and stroke. Chromium builds ICU4C with the
/// smaller "implicithan" root instead, which orders the blocks (the first block with the
/// compatibility ideographs, then Extension A, then B, and so on) and code points within each,
/// and ICU4X's compiled data is the same. Electron Oriel sorts in Chromium's ICU: on Electron
/// 44.7.2 (ICU 78.2) its main process and its renderer both differ from the vectors on exactly
/// these pairs, the same way round as Rust. So Rust follows Electron Oriel here, and both differ
/// from the TypeScript run under Node.
const KNOWN_DIFFERENCES: &[(&str, &str)] = &[
    // 中文, 日本, 漢字, 汉字, 二 and 十 against U+20000 (Extension B) and U+3400 (Extension A).
    ("\u{4E2D}\u{6587}", "\u{20000}"),
    ("\u{4E2D}\u{6587}", "\u{3400}"),
    ("\u{65E5}\u{672C}", "\u{20000}"),
    ("\u{65E5}\u{672C}", "\u{3400}"),
    ("\u{6F22}\u{5B57}", "\u{20000}"),
    ("\u{6F22}\u{5B57}", "\u{3400}"),
    // 漢字 against U+9FFF, added to the first block in Unicode 14.
    ("\u{6F22}\u{5B57}", "\u{9FFF}"),
    ("\u{6C49}\u{5B57}", "\u{20000}"),
    ("\u{6C49}\u{5B57}", "\u{3400}"),
    ("\u{4E8C}", "\u{20000}"),
    ("\u{4E8C}", "\u{3400}"),
    ("\u{5341}", "\u{20000}"),
    ("\u{5341}", "\u{3400}"),
    // The blocks against each other, with U+F900, a compatibility ideograph for U+8C48.
    ("\u{20000}", "\u{3400}"),
    ("\u{20000}", "\u{9FFF}"),
    ("\u{20000}", "\u{F900}"),
    ("\u{3400}", "\u{9FFF}"),
    ("\u{3400}", "\u{F900}"),
    ("\u{9FFF}", "\u{F900}"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SortVectors {
    generated_with: GeneratedWith,
    natural_order: NaturalOrder,
    compare_by_name: Vec<CompareCase>,
    hash_string: Vec<HashCase>,
    sort_media_items: SortCases,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedWith {
    icu: String,
    collator: CollatorOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollatorOptions {
    locale: String,
    numeric: bool,
    sensitivity: String,
    ignore_punctuation: bool,
    case_first: String,
}

#[derive(Deserialize)]
struct NaturalOrder {
    names: Vec<String>,
    classes: Vec<Vec<String>>,
}

#[derive(Clone, Deserialize)]
struct Named {
    name: String,
    path: String,
}

impl NamedPath for Named {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        &self.path
    }
}

#[derive(Deserialize)]
struct CompareCase {
    a: Named,
    b: Named,
    order: i8,
}

#[derive(Deserialize)]
struct HashCase {
    value: String,
    hash: u32,
}

#[derive(Deserialize)]
struct SortCases {
    items: Vec<Item>,
    orders: Vec<SortOrder>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
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

#[derive(Deserialize)]
struct SortOrder {
    mode: GallerySortMode,
    seed: i64,
    ids: Vec<String>,
}

fn vectors() -> SortVectors {
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/media-domain/sort.json");
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json).expect("the vectors parse")
}

fn name_only(name: &str) -> Named {
    Named {
        name: name.to_owned(),
        path: String::new(),
    }
}

fn order_of(order: i8) -> Ordering {
    order.cmp(&0)
}

/// A string as a failure shows it: escaped, cut short when long, with its code points, since
/// many of the corpus's names are invisible or differ only in normalization.
fn describe(value: &str) -> String {
    let count = value.chars().count();
    let shown: String = value.chars().take(24).collect();
    let code_points: Vec<String> = value
        .chars()
        .take(24)
        .map(|character| format!("U+{:04X}", u32::from(character)))
        .collect();
    let more = if count > 24 {
        format!(" ... ({count} characters)")
    } else {
        String::new()
    };
    format!("{shown:?}{more} [{}]", code_points.join(" "))
}

fn fail_with(problems: &[String], what: &str) {
    assert!(
        problems.is_empty(),
        "{} {what}:\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn vectors_were_made_with_the_collator_this_crate_ports() {
    let collator = vectors().generated_with.collator;

    // Electron Oriel resolves `Intl.Collator(undefined)` to the app's locale. English has no
    // collation of its own in CLDR, so its order is the root order this crate uses. Vectors made
    // under another language would test a different order.
    let language = collator.locale.split('-').next().unwrap_or_default();
    assert_eq!(
        language, "en",
        "the vectors were made in {}; this crate collates by the root order, which English uses",
        collator.locale
    );
    assert!(collator.numeric);
    assert_eq!(collator.sensitivity, "base");
    assert!(!collator.ignore_punctuation);
    assert_eq!(collator.case_first, "false");
}

#[test]
fn names_compare_as_the_typescript_ranks_them() {
    let vectors = vectors();
    let order = vectors.natural_order;
    let rank_of: HashMap<&str, usize> = order
        .classes
        .iter()
        .enumerate()
        .flat_map(|(rank, names)| names.iter().map(move |name| (name.as_str(), rank)))
        .collect();
    assert_eq!(
        rank_of.len(),
        order.names.len(),
        "the classes hold each name once"
    );

    let mut asymmetric = Vec::new();
    let mut differences = Vec::new();
    let mut described = Vec::new();
    for (index, a) in order.names.iter().enumerate() {
        for b in &order.names[index + 1..] {
            let expected = rank_of[a.as_str()].cmp(&rank_of[b.as_str()]);
            let actual = compare_by_name(&name_only(a), &name_only(b));
            if compare_by_name(&name_only(b), &name_only(a)) != actual.reverse() {
                asymmetric.push(format!("{} against {}", describe(a), describe(b)));
            }
            if actual != expected {
                differences.push((a.as_str(), b.as_str()));
                described.push(format!(
                    "{} against {}: TypeScript {expected:?}, Rust {actual:?}",
                    describe(a),
                    describe(b)
                ));
            }
        }
    }

    fail_with(&asymmetric, "pairs compare differently each way round");
    assert!(
        differences == KNOWN_DIFFERENCES,
        "{} pairs differ from the vectors (ICU4C {}), where {} are known differences:\n{}",
        differences.len(),
        vectors.generated_with.icu,
        KNOWN_DIFFERENCES.len(),
        described.join("\n")
    );
}

#[test]
fn names_sort_into_the_typescript_order() {
    let order = vectors().natural_order;
    // The pairs above check the known differences, so the names in them are left out here.
    let known: HashSet<&str> = KNOWN_DIFFERENCES
        .iter()
        .flat_map(|&(a, b)| [a, b])
        .collect();
    let items: Vec<Item> = order
        .names
        .iter()
        .filter(|name| !known.contains(name.as_str()))
        .map(|name| Item {
            id: name.clone(),
            name: name.clone(),
            path: String::new(),
            mtime_ms: 0.0,
        })
        .collect();
    let sorted: Vec<String> = sort_media_items(items, GallerySortMode::NameAsc, 0)
        .into_iter()
        .map(|item| item.id)
        .collect();
    let expected: Vec<&String> = order
        .classes
        .iter()
        .flatten()
        .filter(|name| !known.contains(name.as_str()))
        .collect();

    let problems: Vec<String> = sorted
        .iter()
        .zip(expected)
        .enumerate()
        .filter(|(_, (rust, typescript))| rust != typescript)
        .map(|(position, (rust, typescript))| {
            format!(
                "at {position}: TypeScript {}, Rust {}",
                describe(typescript),
                describe(rust)
            )
        })
        .collect();
    fail_with(&problems, "positions differ from the TypeScript's order");
}

#[test]
fn ties_between_names_are_broken_by_path_as_the_typescript_does() {
    let problems: Vec<String> = vectors()
        .compare_by_name
        .iter()
        .filter_map(|case| {
            let expected = order_of(case.order);
            let actual = compare_by_name(&case.a, &case.b);
            (actual != expected).then(|| {
                format!(
                    "{} at {} against {} at {}: TypeScript {expected:?}, Rust {actual:?}",
                    describe(&case.a.name),
                    describe(&case.a.path),
                    describe(&case.b.name),
                    describe(&case.b.path)
                )
            })
        })
        .collect();
    fail_with(&problems, "comparisons differ");
}

#[test]
fn strings_hash_as_the_typescript_hashes_them() {
    let problems: Vec<String> = vectors()
        .hash_string
        .iter()
        .filter_map(|case| {
            let actual = hash_string(&case.value);
            (actual != case.hash).then(|| {
                format!(
                    "{}: TypeScript {}, Rust {actual}",
                    describe(&case.value),
                    case.hash
                )
            })
        })
        .collect();
    fail_with(&problems, "hashes differ");
}

#[test]
fn media_items_sort_as_the_typescript_sorts_them_in_every_mode() {
    let cases = vectors().sort_media_items;
    let problems: Vec<String> = cases
        .orders
        .iter()
        .filter_map(|order| {
            let ids: Vec<String> = sort_media_items(cases.items.clone(), order.mode, order.seed)
                .into_iter()
                .map(|item| item.id)
                .collect();
            (ids != order.ids).then(|| {
                format!(
                    "{:?} with seed {}:\n  TypeScript {}\n  Rust       {}",
                    order.mode,
                    order.seed,
                    order.ids.join(" "),
                    ids.join(" ")
                )
            })
        })
        .collect();
    fail_with(&problems, "orders differ");
}
