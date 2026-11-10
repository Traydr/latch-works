//! JavaScript's string arithmetic, which the keeper rules and the sets' order are written in. The
//! collations are `oriel_core_domain::collation`'s.

use std::cmp::Ordering;

/// A JavaScript string's `length`: its UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `<` on strings: UTF-16 code unit order, which differs from Rust's byte order
/// for characters past the Basic Multilingual Plane.
pub fn js_string_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
