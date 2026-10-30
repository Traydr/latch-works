//! The summary a row's rounds reduce to: the median and the spread (min to max), as the scorecard
//! reports every number, and the order in which several apps take their turns.

/// The median of a row's rounds, the smallest and the largest, and how many rounds gave a value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Summary {
    pub median: f64,
    pub min: f64,
    pub max: f64,
    pub count: usize,
}

impl Summary {
    /// `None` when no round gave a value. NaN values are a round that measured nothing, so they
    /// are left out rather than poisoning the median.
    pub fn of(values: &[f64]) -> Option<Self> {
        let mut sorted: Vec<f64> = values.iter().copied().filter(|v| !v.is_nan()).collect();
        if sorted.is_empty() {
            return None;
        }
        sorted.sort_by(f64::total_cmp);
        let middle = sorted.len() / 2;
        // The mean of the middle two for an even count, as `oriel-bench`'s median.
        let median = if sorted.len() % 2 == 1 {
            sorted[middle]
        } else {
            (sorted[middle - 1] + sorted[middle]) / 2.
        };
        Some(Self {
            median,
            min: sorted[0],
            max: sorted[sorted.len() - 1],
            count: sorted.len(),
        })
    }

    /// `383 (370–474)`, or the value alone when every round agreed or there was one; ` n=2` when
    /// fewer than `rounds` rounds gave a value.
    pub fn cell(&self, rounds: usize) -> String {
        let mut cell = number(self.median);
        if self.count > 1 && self.min != self.max {
            cell.push_str(&format!(" ({}–{})", number(self.min), number(self.max)));
        }
        if self.count < rounds {
            cell.push_str(&format!(" n={}", self.count));
        }
        cell
    }
}

/// A number as the scorecard writes it: whole numbers without decimals, and otherwise fewer
/// decimals the larger the number (`8.33`, `18.1`, `383`).
pub fn number(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    let decimals = if value.fract() == 0. || value.abs() >= 100. {
        0
    } else if value.abs() >= 10. {
        1
    } else {
        2
    };
    format!("{value:.decimals$}")
}

/// How `other`'s median differs from `base`'s, as a signed percentage of `base`'s (`+3.2 %`,
/// `−10 %`); empty when `base` is zero, where a ratio means nothing.
pub fn change(base: f64, other: f64) -> String {
    if base == 0. || !base.is_finite() || !other.is_finite() {
        return String::new();
    }
    let percent = (other - base) / base.abs() * 100.;
    let magnitude = number(percent.abs());
    if magnitude.trim_start_matches(['0', '.']).is_empty() {
        return "0 %".into();
    }
    let sign = if percent < 0. { '−' } else { '+' };
    format!("{sign}{magnitude} %")
}

/// The order of the apps in a round, so that an A/B is interleaved: A, B in the first round,
/// B, A in the second, A, B again in the third. With more apps the order reverses the same way.
pub fn turns(round: usize, apps: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..apps).collect();
    if round % 2 == 1 {
        order.reverse();
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_median_is_the_middle_or_the_mean_of_the_middle_two() {
        let odd = Summary::of(&[474.1, 382.8, 381.6]).unwrap();
        assert_eq!(
            (odd.median, odd.min, odd.max, odd.count),
            (382.8, 381.6, 474.1, 3)
        );
        let even = Summary::of(&[8., 2., 4., 6.]).unwrap();
        assert_eq!(even.median, 5.);
        assert_eq!(Summary::of(&[]), None);
    }

    #[test]
    fn a_round_without_a_value_is_left_out() {
        let summary = Summary::of(&[f64::NAN, 10., 30.]).unwrap();
        assert_eq!((summary.median, summary.count), (20., 2));
        assert_eq!(Summary::of(&[f64::NAN]), None);
        assert_eq!(summary.cell(3), "20 (10–30) n=2");
    }

    #[test]
    fn cells_show_the_median_then_the_spread() {
        assert_eq!(
            Summary::of(&[383., 370., 474.]).unwrap().cell(3),
            "383 (370–474)"
        );
        assert_eq!(Summary::of(&[8.33, 8.33, 8.33]).unwrap().cell(3), "8.33");
        assert_eq!(Summary::of(&[0.35]).unwrap().cell(1), "0.35");
        assert_eq!(
            Summary::of(&[18.11, 9.97, 12.]).unwrap().cell(3),
            "12 (9.97–18.1)"
        );
    }

    #[test]
    fn numbers_take_fewer_decimals_as_they_grow() {
        assert_eq!(number(17_742.), "17742");
        assert_eq!(number(332.54), "333");
        assert_eq!(number(18.11), "18.1");
        assert_eq!(number(8.333), "8.33");
        assert_eq!(number(0.), "0");
    }

    #[test]
    fn changes_are_signed_percentages_of_the_first_app() {
        assert_eq!(change(400., 360.), "−10 %");
        assert_eq!(change(383., 395.3), "+3.21 %");
        assert_eq!(change(100., 100.), "0 %");
        assert_eq!(change(0., 5.), "");
    }

    #[test]
    fn apps_take_turns_a_b_b_a() {
        let rounds: Vec<Vec<usize>> = (0..4).map(|round| turns(round, 2)).collect();
        assert_eq!(rounds, [[0, 1], [1, 0], [0, 1], [1, 0]]);
        assert_eq!(turns(1, 3), [2, 1, 0]);
        assert_eq!(turns(0, 1), [0]);
    }
}
