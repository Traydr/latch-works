//! The text orders glazier-core sorts with, through ICU4X's root collation as `oriel-core-domain`
//! uses it: never the system's locale (plan 063, overnight decisions).

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{CollatorBorrowed, CollatorPreferences};

fn collator(numeric: bool, strength: Option<Strength>) -> CollatorBorrowed<'static> {
    let mut preferences = CollatorPreferences::default();
    if numeric {
        preferences.numeric_ordering = Some(CollationNumericOrdering::True);
    }
    let mut options = CollatorOptions::default();
    options.strength = strength;
    CollatorBorrowed::try_new(preferences, options)
        .expect("the compiled collation data has the root locale")
}

/// `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`: the keeper rules' name
/// order, the same collator `oriel-core-domain`'s natural order is.
static NATURAL: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| collator(true, Some(Strength::Primary)));

/// `localeCompare(other, undefined, { numeric: true })`: tertiary strength, digits by value.
static NUMERIC: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(true, None));

/// `localeCompare(other)`: the root collation at its default, tertiary, strength.
static DEFAULT: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(false, None));

pub fn natural_order(left: &str, right: &str) -> Ordering {
    NATURAL.compare(left, right)
}

pub fn numeric_order(left: &str, right: &str) -> Ordering {
    NUMERIC.compare(left, right)
}

pub fn locale_order(left: &str, right: &str) -> Ordering {
    DEFAULT.compare(left, right)
}

/// A JavaScript string's `length`: its UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `<` on strings: UTF-16 code unit order, which differs from Rust's byte order
/// for characters past the Basic Multilingual Plane.
pub fn js_string_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
