//! The perceptual hash, as `glazier-core/src/similarity/phash.ts` makes it.
//!
//! The arithmetic is the same f64 operations in the same order, and the cosine table is V8's own
//! `Math.cos` values, bit for bit: the platform's `cos` differs from V8's in the last bit of 11 of
//! the 256 entries on macOS, which is enough to flip a bit whose coefficient sits at the median.

use std::fmt;

/// The hash reads a 32×32 greyscale thumbnail and keeps its lowest 8×8 DCT frequencies.
pub const PHASH_INPUT_SIZE: usize = 32;

const HASH_SIZE: usize = 8;

/// `Math.cos(((2 * x + 1) * u * Math.PI) / 64)` in V8 for u < 8, x < 32, row-major by u, as
/// IEEE 754 bits.
#[rustfmt::skip]
const COSINE_BITS: [u64; HASH_SIZE * PHASH_INPUT_SIZE] = [
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000, 0x3ff0000000000000,
    0x3feff621e3796d7e, 0x3fefa7557f08a517, 0x3fef0a7efb9230d7, 0x3fee212104f686e5,
    0x3feced7af43cc773, 0x3feb728345196e3e, 0x3fe9b3e047f38741, 0x3fe7b5df226aafb0,
    0x3fe57d69348cec9f, 0x3fe30ff7fce17036, 0x3fe073879922ffed, 0x3fdb5d1009e15cc2,
    0x3fd58f9a75ab1fdd, 0x3fcf19f97b215f1e, 0x3fc2c8106e8e613a, 0x3fa91f65f10dd824,
    0xbfa91f65f10dd813, 0xbfc2c8106e8e6136, 0xbfcf19f97b215f1a, 0xbfd58f9a75ab1fdb,
    0xbfdb5d1009e15cbc, 0xbfe073879922ffec, 0xbfe30ff7fce17035, 0xbfe57d69348ceca0,
    0xbfe7b5df226aafad, 0xbfe9b3e047f38740, 0xbfeb728345196e3d, 0xbfeced7af43cc773,
    0xbfee212104f686e4, 0xbfef0a7efb9230d7, 0xbfefa7557f08a517, 0xbfeff621e3796d7e,
    0x3fefd88da3d12526, 0x3fee9f4156c62dda, 0x3fec38b2f180bdb1, 0x3fe8bc806b151741,
    0x3fe44cf325091dd6, 0x3fde2b5d3806f63e, 0x3fd294062ed59f05, 0x3fb917a6bc29b438,
    0xbfb917a6bc29b42f, 0xbfd294062ed59f02, 0xbfde2b5d3806f63c, 0xbfe44cf325091dd5,
    0xbfe8bc806b151741, 0xbfec38b2f180bdb0, 0xbfee9f4156c62dda, 0xbfefd88da3d12525,
    0xbfefd88da3d12526, 0xbfee9f4156c62ddb, 0xbfec38b2f180bdb1, 0xbfe8bc806b151742,
    0xbfe44cf325091dda, 0xbfde2b5d3806f640, 0xbfd294062ed59f07, 0xbfb917a6bc29b421,
    0x3fb917a6bc29b407, 0x3fd294062ed59f00, 0x3fde2b5d3806f63a, 0x3fe44cf325091dd7,
    0x3fe8bc806b15173d, 0x3fec38b2f180bdaf, 0x3fee9f4156c62dda, 0x3fefd88da3d12526,
    0x3fefa7557f08a517, 0x3feced7af43cc773, 0x3fe7b5df226aafb0, 0x3fe073879922ffed,
    0x3fcf19f97b215f1e, 0xbfa91f65f10dd813, 0xbfd58f9a75ab1fdb, 0xbfe30ff7fce17035,
    0xbfe9b3e047f38740, 0xbfee212104f686e4, 0xbfeff621e3796d7e, 0xbfef0a7efb9230d7,
    0xbfeb728345196e3e, 0xbfe57d69348ceca2, 0xbfdb5d1009e15cc7, 0xbfc2c8106e8e614e,
    0x3fc2c8106e8e6141, 0x3fdb5d1009e15cc1, 0x3fe57d69348cec9f, 0x3feb728345196e3d,
    0x3fef0a7efb9230d7, 0x3feff621e3796d7e, 0x3fee212104f686e6, 0x3fe9b3e047f38744,
    0x3fe30ff7fce17034, 0x3fd58f9a75ab1fdd, 0x3fa91f65f10dd828, 0xbfcf19f97b215ef3,
    0xbfe073879922ffeb, 0xbfe7b5df226aafb1, 0xbfeced7af43cc771, 0xbfefa7557f08a517,
    0x3fef6297cff75cb0, 0x3fea9b66290ea1a3, 0x3fe1c73b39ae68c9, 0x3fc8f8b83c69a60d,
    0xbfc8f8b83c69a608, 0xbfe1c73b39ae68c6, 0xbfea9b66290ea1a4, 0xbfef6297cff75cb0,
    0xbfef6297cff75cb0, 0xbfea9b66290ea1a5, 0xbfe1c73b39ae68c8, 0xbfc8f8b83c69a619,
    0x3fc8f8b83c69a60c, 0x3fe1c73b39ae68c5, 0x3fea9b66290ea1a3, 0x3fef6297cff75caf,
    0x3fef6297cff75cb0, 0x3fea9b66290ea1a6, 0x3fe1c73b39ae68c9, 0x3fc8f8b83c69a61d,
    0xbfc8f8b83c69a5e8, 0xbfe1c73b39ae68c4, 0xbfea9b66290ea1a2, 0xbfef6297cff75cb1,
    0xbfef6297cff75cb2, 0xbfea9b66290ea1a6, 0xbfe1c73b39ae68ca, 0xbfc8f8b83c69a602,
    0x3fc8f8b83c69a5e4, 0x3fe1c73b39ae68c3, 0x3fea9b66290ea1a2, 0x3fef6297cff75cb0,
    0x3fef0a7efb9230d7, 0x3fe7b5df226aafb0, 0x3fd58f9a75ab1fdd, 0xbfc2c8106e8e6136,
    0xbfe30ff7fce17035, 0xbfeced7af43cc773, 0xbfeff621e3796d7e, 0xbfeb728345196e3e,
    0xbfe073879922ffee, 0xbfa91f65f10dd816, 0x3fdb5d1009e15cc1, 0x3fe9b3e047f38742,
    0x3fefa7557f08a516, 0x3fee212104f686e6, 0x3fe57d69348ceca2, 0x3fcf19f97b215f27,
    0xbfcf19f97b215ef3, 0xbfe57d69348cec99, 0xbfee212104f686e2, 0xbfefa7557f08a518,
    0xbfe9b3e047f38745, 0xbfdb5d1009e15ccb, 0x3fa91f65f10dd7be, 0x3fe073879922ffea,
    0x3feb728345196e3c, 0x3feff621e3796d7e, 0x3feced7af43cc774, 0x3fe30ff7fce17036,
    0x3fc2c8106e8e613c, 0xbfd58f9a75ab1fde, 0xbfe7b5df226aafb0, 0xbfef0a7efb9230d8,
    0x3fee9f4156c62dda, 0x3fe44cf325091dd6, 0x3fb917a6bc29b438, 0xbfde2b5d3806f63c,
    0xbfec38b2f180bdb0, 0xbfefd88da3d12526, 0xbfe8bc806b151742, 0xbfd294062ed59f07,
    0x3fd294062ed59f00, 0x3fe8bc806b15173d, 0x3fefd88da3d12526, 0x3fec38b2f180bdb1,
    0x3fde2b5d3806f642, 0xbfb917a6bc29b3fe, 0xbfe44cf325091dd0, 0xbfee9f4156c62dd7,
    0xbfee9f4156c62dd9, 0xbfe44cf325091dd5, 0xbfb917a6bc29b432, 0x3fde2b5d3806f636,
    0x3fec38b2f180bdae, 0x3fefd88da3d12526, 0x3fe8bc806b151747, 0x3fd294062ed59f1c,
    0xbfd294062ed59f09, 0xbfe8bc806b151740, 0xbfefd88da3d12525, 0xbfec38b2f180bdbb,
    0xbfde2b5d3806f647, 0x3fb917a6bc29b463, 0x3fe44cf325091dcd, 0x3fee9f4156c62ddb,
    0x3fee212104f686e5, 0x3fe073879922ffed, 0xbfc2c8106e8e6136, 0xbfe7b5df226aafad,
    0xbfeff621e3796d7e, 0xbfe9b3e047f38741, 0xbfcf19f97b215f23, 0x3fdb5d1009e15cc1,
    0x3feced7af43cc771, 0x3fef0a7efb9230d8, 0x3fe30ff7fce17034, 0xbfa91f65f10dd7d0,
    0xbfe57d69348cec99, 0xbfefa7557f08a517, 0xbfeb728345196e40, 0xbfd58f9a75ab1fee,
    0x3fd58f9a75ab1fe0, 0x3feb728345196e3c, 0x3fefa7557f08a518, 0x3fe57d69348cec9e,
    0x3fa91f65f10dd84b, 0xbfe30ff7fce1702e, 0xbfef0a7efb9230d8, 0xbfeced7af43cc774,
    0xbfdb5d1009e15cb2, 0x3fcf19f97b215ee6, 0x3fe9b3e047f3873f, 0x3feff621e3796d7e,
    0x3fe7b5df226aafb8, 0x3fc2c8106e8e6145, 0xbfe073879922fff5, 0xbfee212104f686e0,
];

/// A 64-bit perceptual hash. glazier-core keeps it as two unsigned 32-bit halves; this is the
/// high half followed by the low one, so the bits and the hex form are the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Hash64(pub u64);

impl Hash64 {
    /// Bits that differ between two hashes.
    pub fn distance(self, other: Hash64) -> u32 {
        (self.0 ^ other.0).count_ones()
    }

    /// Reads the 16 lowercase hex digits [`fmt::Display`] writes, and nothing else.
    pub fn parse(hex: &str) -> Option<Hash64> {
        let valid = hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        valid
            .then(|| u64::from_str_radix(hex, 16).ok())
            .flatten()
            .map(Hash64)
    }
}

impl fmt::Display for Hash64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

/// The perceptual hash of a 32×32 8-bit greyscale image (1024 bytes, row-major): each of the 64
/// low-frequency DCT coefficients becomes a bit set when it exceeds their median. Resizing,
/// recompression and format changes move few bits; different pictures differ in about half.
///
/// Returns `None` when `pixels` is not 32×32.
pub fn perceptual_hash(pixels: &[u8]) -> Option<Hash64> {
    if pixels.len() != PHASH_INPUT_SIZE * PHASH_INPUT_SIZE {
        return None;
    }
    let cosine = |u: usize, x: usize| f64::from_bits(COSINE_BITS[u * PHASH_INPUT_SIZE + x]);

    // Rows first: row_sums[y][u] = Σx pixel(x, y)·cos_u(x).
    let mut row_sums = [0.0f64; PHASH_INPUT_SIZE * HASH_SIZE];
    for y in 0..PHASH_INPUT_SIZE {
        for u in 0..HASH_SIZE {
            let mut sum = 0.0;
            for x in 0..PHASH_INPUT_SIZE {
                sum += f64::from(pixels[y * PHASH_INPUT_SIZE + x]) * cosine(u, x);
            }
            row_sums[y * HASH_SIZE + u] = sum;
        }
    }

    let mut coefficients = [0.0f64; HASH_SIZE * HASH_SIZE];
    for v in 0..HASH_SIZE {
        for u in 0..HASH_SIZE {
            let mut sum = 0.0;
            for y in 0..PHASH_INPUT_SIZE {
                sum += row_sums[y * HASH_SIZE + u] * cosine(v, y);
            }
            coefficients[v * HASH_SIZE + u] = sum;
        }
    }

    // The DC term (overall brightness) would dominate the median, so it is left out of it.
    let median = median_of(&coefficients[1..]);
    let mut hash = 0u64;
    for (index, coefficient) in coefficients.iter().enumerate() {
        if *coefficient > median {
            hash |= 1 << (63 - index);
        }
    }
    Some(Hash64(hash))
}

/// The median as `Float64Array.prototype.sort` orders numbers, which `total_cmp` matches for
/// everything but NaN, and a DCT of bytes has none.
fn median_of(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cosine_table_is_the_closed_form_to_within_a_bit() {
        for u in 0..HASH_SIZE {
            for x in 0..PHASH_INPUT_SIZE {
                let exact = ((((2 * x + 1) * u) as f64) * std::f64::consts::PI / 64.0).cos();
                let ours = f64::from_bits(COSINE_BITS[u * PHASH_INPUT_SIZE + x]);
                assert!(
                    exact.to_bits().abs_diff(ours.to_bits()) <= 1,
                    "cos entry u={u} x={x} is {ours}, not about {exact}"
                );
            }
        }
    }

    #[test]
    fn hashes_round_trip_through_hex() {
        let hash = Hash64(0x0123_4567_89ab_cdef);
        assert_eq!(hash.to_string(), "0123456789abcdef");
        assert_eq!(Hash64::parse("0123456789abcdef"), Some(hash));
        assert_eq!(Hash64::parse("0123456789ABCDEF"), None);
        assert_eq!(Hash64::parse("0123"), None);
    }
}
