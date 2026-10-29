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
