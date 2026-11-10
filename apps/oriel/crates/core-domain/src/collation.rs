//! The text orders Oriel sorts with, all through ICU4X's root collation: Oriel never follows the
//! system's locale (the owner, 2026-10-29), so a Lithuanian system would order a few names
//! differently from a JavaScript app that does.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{CollatorBorrowed, CollatorPreferences};

/// One of the orders, named for the JavaScript call it matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collation {
    /// `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`: runs of digits by
    /// their value, and only base letters count, so case, accents and width do not. The gallery's
    /// and Tidy's name order.
    Natural,
    /// `localeCompare(other, undefined, { sensitivity: "base" })`: base letters only, digits as
    /// characters. View's folder list.
    Base,
    /// `localeCompare(other, undefined, { numeric: true })`: tertiary strength, digits by value.
    Numeric,
    /// `localeCompare(other)`: tertiary strength, the default. Sync's scan order.
    Locale,
}

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

static NATURAL: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| collator(true, Some(Strength::Primary)));
static BASE: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| collator(false, Some(Strength::Primary)));
static NUMERIC: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(true, None));
static LOCALE: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(false, None));

impl Collation {
    fn collator(self) -> &'static CollatorBorrowed<'static> {
        match self {
            Self::Natural => &NATURAL,
            Self::Base => &BASE,
            Self::Numeric => &NUMERIC,
            Self::Locale => &LOCALE,
        }
    }

    pub fn compare(self, a: &str, b: &str) -> Ordering {
        self.collator().compare(a, b)
    }

    /// Appends the sort key of `text` to `key`: comparing two keys as bytes orders their texts as
    /// [`Collation::compare`] does.
    pub fn write_sort_key(self, text: &str, key: &mut Vec<u8>) {
        let Ok(()) = self.collator().write_sort_key_to(text, key);
    }

    pub fn sort_key(self, text: &str) -> Box<[u8]> {
        let mut key = Vec::with_capacity(text.len() * 2);
        self.write_sort_key(text, &mut key);
        key.into_boxed_slice()
    }

    /// Sorts `items` in this order by the sort keys made for them earlier, keeping those it calls
    /// equal in the order they came, as a stable sort through [`Collation::compare`] would.
    ///
    /// Comparing keys as bytes is many times quicker than comparing texts through the collator.
    /// The order is then checked pair by pair against the collator itself, and should the two
    /// ever disagree the items are sorted through the collator instead, so the result is always
    /// its order.
    pub fn sort_by_keys<T>(
        self,
        items: &mut [T],
        text: impl Fn(&T) -> &str,
        key: impl Fn(&T) -> &[u8],
    ) {
        items.sort_by(|left, right| key(left).cmp(key(right)));
        let agrees =
            items
                .windows(2)
                .all(|pair| match self.compare(text(&pair[0]), text(&pair[1])) {
                    Ordering::Less => true,
                    // Equal keys kept the order they came in; unequal ones may not have.
                    Ordering::Equal => key(&pair[0]) == key(&pair[1]),
                    Ordering::Greater => false,
                });
        if !agrees {
            log::warn!("the collator's sort keys disagree with it; sorting through it");
            items.sort_by(|left, right| self.compare(text(left), text(right)));
        }
    }
}
