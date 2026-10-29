//! JavaScript's number arithmetic where glazier-core's rules depend on it.

/// `Math.round`: halves round up, toward positive infinity.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// V8's `Math.log` on Apple silicon, bit for bit, copied from `oriel-core-domain` (where it is
/// private): the similar-set search bins pictures by `Math.log` of their aspect ratio.
///
/// V8 computes it with fdlibm's `__ieee754_log`, and clang, compiling V8 for arm64, fuses each
/// multiply-add written inside one expression into one instruction. Unfused, as an x86-64 build
/// computes it, the result differs from Node's in the last bit for about 3 inputs in 10,000; the
/// platform's `ln` differs for about 1 in 100. With the fused steps below it matched Node 24.18
/// (V8 on arm64) on 4 million inputs and on every power of two. A Windows build of Electron
/// Oriel, unfused, can itself differ from these vectors in the last bit.
pub fn v8_log(x: f64) -> f64 {
    const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
    const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
    const TWO54: f64 = f64::from_bits(0x4350_0000_0000_0000);
    const LG1: f64 = f64::from_bits(0x3fe5_5555_5555_5593);
    const LG2: f64 = f64::from_bits(0x3fd9_9999_9997_fa04);
    const LG3: f64 = f64::from_bits(0x3fd2_4924_9422_9359);
    const LG4: f64 = f64::from_bits(0x3fcc_71c5_1d8e_78af);
    const LG5: f64 = f64::from_bits(0x3fc7_4664_96cb_03de);
    const LG6: f64 = f64::from_bits(0x3fc3_9a09_d078_c69f);
    const LG7: f64 = f64::from_bits(0x3fc2_f112_df3e_5244);
    // fdlibm writes 0.33333333333333333, which is this double.
    const ONE_THIRD: f64 = 0.333_333_333_333_333_3;

    let mut x = x;
    // fdlibm works on the high and low 32-bit words of the double.
    let mut high = (x.to_bits() >> 32) as i32;
    let low = x.to_bits() as u32;
    let mut k: i32 = 0;

    if high < 0x0010_0000 {
        if (high & 0x7fff_ffff) as u32 | low == 0 {
            return f64::NEG_INFINITY;
        }
        if high < 0 {
            return f64::NAN;
        }
        // A subnormal: scale it into the normal range.
        k -= 54;
        x *= TWO54;
        high = (x.to_bits() >> 32) as i32;
    }
    if high >= 0x7ff0_0000 {
        return x + x;
    }

    k += (high >> 20) - 1023;
    high &= 0x000f_ffff;
    let i = (high + 0x95f64) & 0x10_0000;
    // Normalize x, or x / 2, into [sqrt(2) / 2, sqrt(2)).
    let normalized_high = (high | (i ^ 0x3ff0_0000)) as u32;
    x = f64::from_bits((u64::from(normalized_high) << 32) | (x.to_bits() & 0xffff_ffff));
    k += i >> 20;
    let f = x - 1.0;
    let dk = f64::from(k);

    if (0x000f_ffff & (2 + high)) < 3 {
        // |f| < 2^-20.
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                dk.mul_add(LN2_HI, dk * LN2_LO)
            };
        }
        let r = f * f * (-ONE_THIRD).mul_add(f, 0.5);
        return if k == 0 {
            f - r
        } else {
            dk.mul_add(LN2_HI, -((-dk).mul_add(LN2_LO, r) - f))
        };
    }

    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * w.mul_add(w.mul_add(LG6, LG4), LG2);
    let t2 = z * w.mul_add(w.mul_add(w.mul_add(LG7, LG5), LG3), LG1);
    let r = t2 + t1;

    if (high - 0x6147a) | (0x6b851 - high) > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (-s).mul_add(hfsq + r, hfsq)
        } else {
            dk.mul_add(LN2_HI, -((hfsq - s.mul_add(hfsq + r, dk * LN2_LO)) - f))
        }
    } else if k == 0 {
        (-s).mul_add(f - r, f)
    } else {
        dk.mul_add(LN2_HI, -(s.mul_add(f - r, -(dk * LN2_LO)) - f))
    }
}

/// `value.toFixed(digits)` as the ECMAScript spec defines it, copied from `oriel-core-domain`
/// (where it is private): the exact decimal value of the double, rounded to `digits` places
/// with a tie going away from zero, where Rust's `{:.1}` sends a tie to the even digit. History's
/// byte counts ("84.6 KB") are written with it.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value.abs() >= 1e21 {
        return format!("{value:e}").replacen('e', "e+", 1);
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let magnitude = value.abs();
    let exact = format!("{magnitude:.*}", fraction_digits(magnitude).max(digits + 1));
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction
        .as_bytes()
        .get(digits)
        .is_some_and(|&digit| digit >= b'5')
    {
        round_up(&mut kept);
    }
    let point = kept.len() - digits;
    let mut text = String::with_capacity(sign.len() + kept.len() + 1);
    text.push_str(sign);
    text.extend(kept[..point].iter().map(|&digit| char::from(digit)));
    if digits > 0 {
        text.push('.');
        text.extend(kept[point..].iter().map(|&digit| char::from(digit)));
    }
    text
}

/// How many decimal places the exact value of a finite double has.
fn fraction_digits(value: f64) -> usize {
    if value == 0.0 {
        return 0;
    }
    let bits = value.to_bits();
    let biased_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = bits & ((1 << 52) - 1);
    let (significand, exponent) = if biased_exponent == 0 {
        (mantissa, -1074)
    } else {
        (mantissa | (1 << 52), biased_exponent - 1075)
    };
    let lowest_bit = exponent + significand.trailing_zeros() as i32;
    usize::try_from(-lowest_bit).unwrap_or(0)
}

/// Adds one to a run of ASCII digits, carrying, and growing it by a leading 1 when it was all 9s.
fn round_up(digits: &mut Vec<u8>) {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

/// Bytes in decimal units with one decimal, as glazier-core's `formatBytes` writes them:
/// "84.6 KB", "512 B".
pub fn format_bytes(bytes: f64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", js_round(value))
    } else {
        format!("{} {}", to_fixed(value, 1), UNITS[unit])
    }
}

/// A count as `Intl.NumberFormat("en-US")` writes it: digits grouped by threes with commas.
pub fn format_count(count: i64) -> String {
    let digits = count.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if count < 0 {
        grouped.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// "1 file", "206 files": a count with the noun that agrees with it, as `countOf` writes it.
pub fn count_of(count: i64, one: &str, many: &str) -> String {
    format!(
        "{} {}",
        format_count(count),
        if count == 1 { one } else { many }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_and_counts_read_as_glazier_core_writes_them() {
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(1250.0), "1.3 KB");
        assert_eq!(format_bytes(84_640.0), "84.6 KB");
        assert_eq!(format_bytes(999_950.0), "1000.0 KB");
        assert_eq!(format_bytes(5e12), "5000.0 GB");
        assert_eq!(count_of(1, "file", "files"), "1 file");
        assert_eq!(count_of(1206, "file", "files"), "1,206 files");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }
}
