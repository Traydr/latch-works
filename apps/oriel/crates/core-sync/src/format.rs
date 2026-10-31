//! Text as the TypeScript writes it: timestamps, counts, Node's file errors, and numbers in JSON.

use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serializer;

/// `Date.prototype.toISOString`: UTC, to the millisecond, `2026-10-29T01:32:29.123Z`.
pub fn iso_timestamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis = since.subsec_millis();
    let seconds = since.as_secs();
    let (days, of_day) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Milliseconds since the epoch of an ISO timestamp `iso_timestamp` wrote, for "2d ago".
pub fn parse_iso_timestamp(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let millis = if bytes.get(19) == Some(&b'.') {
        number(20..23).unwrap_or(0)
    } else {
        0
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis)
}

/// Howard Hinnant's `civil_from_days`: the proleptic Gregorian date of a day count.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// A count as `toLocaleString()` writes it in English: `1,234`.
pub fn format_count(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// The message Node gives a failed file call: `ENOENT: no such file or directory, stat
/// '/a/b'`. lockstep-core shows these as they are, so the doctor's details read the same.
pub fn node_error_message(error: &io::Error, syscall: &str, path: &str) -> String {
    let (code, description) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(1) => ("EPERM", "operation not permitted"),
        Some(21) => ("EISDIR", "illegal operation on a directory"),
        Some(62) => ("ELOOP", "too many symbolic links encountered"),
        Some(63) => ("ENAMETOOLONG", "name too long"),
        Some(5) => ("EIO", "i/o error"),
        _ => return format!("{error}, {syscall} '{path}'"),
    };
    format!("{code}: {description}, {syscall} '{path}'")
}

/// `formatPushError`: the error's message, with its cause's in brackets when it has one.
pub(crate) fn format_push_error(error: &anyhow::Error) -> String {
    let message = error.to_string();
    match error.chain().nth(1) {
        Some(cause) => format!("{message} ({cause})"),
        None => message,
    }
}

/// Writes a number as `JSON.stringify` does: whole numbers without a fraction.
pub(crate) fn serialize_js_number<S: Serializer>(
    value: &f64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

pub(crate) fn serialize_optional_js_number<S: Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serialize_js_number(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn writes_iso_timestamps_as_javascript_does() {
        let at = UNIX_EPOCH + Duration::from_millis(1_761_701_549_123);
        assert_eq!(iso_timestamp(at), "2025-10-29T01:32:29.123Z");
        assert_eq!(iso_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(iso_timestamp(leap), "2000-02-29T00:00:00.000Z");
        assert_eq!(
            parse_iso_timestamp("2025-10-29T01:32:29.123Z"),
            Some(1_761_701_549_123)
        );
    }

    #[test]
    fn groups_counts_by_thousands() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1000), "1,000");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }
}
