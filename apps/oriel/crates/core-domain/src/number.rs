//! JavaScript's number arithmetic where `paths.ts` relies on it: V8's `Math.log` and
//! `Number.prototype.toFixed`. Rust's own differ in the last bit and in how they round a tie,
//! and `formatBytes` shows both differences.

/// V8's `Math.log` on Apple silicon, bit for bit.
///
/// V8 computes it with fdlibm's `__ieee754_log`, and clang, compiling V8 for arm64, fuses each
/// multiply-add written inside one expression into one instruction. Unfused, as an x86-64 build
/// computes it, the result differs from Node's in the last bit for about 3 inputs in 10,000; the
/// platform's `ln` differs for about 1 in 100. With the fused steps below it matched Node 24.18
/// (V8 on arm64) on 4 million inputs and on every power of two. A Windows build of Electron
/// Oriel, unfused, can itself differ from these vectors in the last bit.
pub(crate) fn v8_log(x: f64) -> f64 {
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

/// `value.toFixed(digits)` as the ECMAScript spec defines it: the exact decimal value of the
/// double, rounded to `digits` places with a tie going away from zero. Rust's `{:.1}` is exact
/// too but sends a tie to the even digit, so `1.25` is `"1.3"` here and `"1.2"` there.
pub(crate) fn to_fixed(value: f64, digits: usize) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value.abs() >= 1e21 {
        // The spec falls back to the number's own string, which is exponential this large.
        return format!("{value:e}").replacen('e', "e+", 1);
    }

    // `-0.0 < 0.0` is false, so negative zero prints without a sign, as in JavaScript.
    let sign = if value < 0.0 { "-" } else { "" };
    let magnitude = value.abs();
    // Printing at least the double's own fraction digits gives its exact decimal value.
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

/// How many decimal places the exact value of a finite double has: as many as it has binary
/// places, since each binary place adds one decimal place.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_ties_away_from_zero_on_the_exact_value() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(0.75, 1), "0.8");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(1.45, 1), "1.4"); // 1.45 is 1.4499999... as a double
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(999.95, 1), "1000.0"); // 999.9500000000000454... as a double
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(5e-324, 1), "0.0");
        assert_eq!(to_fixed(1e21, 1), "1e+21");
    }

    #[test]
    fn v8_log_agrees_with_v8_where_unfused_fdlibm_does_not() {
        // `Math.log` in Node 24.18 on arm64. Unfused fdlibm, and this Mac's `ln`, are one bit off
        // on each of these.
        let node = [
            (1_866.033_999_999_999_9, 0x401e_2054_0b3d_02fe),
            (333.251_999_999_999_95, 0x4017_3c50_0255_2bce),
            (47_708_889_248_571.0, 0x403f_7f02_f4b7_a8a8),
            (94_543_389_552_228.0, 0x4040_170c_dc79_ea62),
        ];
        for (x, log) in node {
            assert_eq!(v8_log(x).to_bits(), log, "Math.log({x})");
        }
        assert_eq!(v8_log(1024.0), 6.931_471_805_599_453);
        assert_eq!(v8_log(1.0), 0.0);
        assert_eq!(v8_log(0.0), f64::NEG_INFINITY);
        assert!(v8_log(-1.0).is_nan());
    }
}
