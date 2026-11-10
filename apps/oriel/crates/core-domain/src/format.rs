//! How every mode writes numbers, sizes, lengths of time and dates for people to read, and the
//! timestamps the data files hold.
//!
//! Sizes are in decimal units (1 KB is 1,000 bytes) everywhere in Oriel (the owner,
//! 2026-11-09). Counts and dates are written as `Intl.NumberFormat` and `Intl.DateTimeFormat`
//! write them in English, since Oriel never follows the system's locale.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::number::{js_round, to_fixed};

/// A number of bytes or milliseconds, whatever type the caller holds it in.
pub trait Number: Copy {
    fn value(self) -> f64;
}

macro_rules! number {
    ($($kind:ty),*) => {$(
        impl Number for $kind {
            fn value(self) -> f64 {
                self as f64
            }
        }
    )*};
}
number!(f64, f32, i64, u64, i32, u32, usize);

/// A count of something, whatever integer type the caller holds it in.
pub trait Integer: Copy {
    fn value(self) -> i128;
}

macro_rules! integer {
    ($($kind:ty),*) => {$(
        impl Integer for $kind {
            fn value(self) -> i128 {
                self as i128
            }
        }
    )*};
}
integer!(i64, u64, i32, u32, usize);

const BYTE_UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// A size in decimal units: "512 B", "1.5 KB", "84.6 KB", "250 MB". One decimal under 100, none
/// from 100 up; a value that rounds up to 1,000 reads as one of the next unit.
pub fn bytes(bytes: impl Number) -> String {
    let bytes = bytes.value();
    let mut value = bytes;
    let mut unit = 0;
    while value.abs() >= 1000. && unit < BYTE_UNITS.len() - 1 {
        value /= 1000.;
        unit += 1;
    }
    if unit == 0 {
        return format!("{} B", js_round(bytes));
    }
    let mut text = to_fixed(value, 1);
    if reads_at_least(&text, 100.) {
        text = to_fixed(value, 0);
        if reads_at_least(&text, 1000.) && unit < BYTE_UNITS.len() - 1 {
            unit += 1;
            text = to_fixed(value / 1000., 1);
        }
    }
    format!("{text} {}", BYTE_UNITS[unit])
}

fn reads_at_least(text: &str, bound: f64) -> bool {
    text.parse::<f64>().is_ok_and(|value| value.abs() >= bound)
}

/// A whole number with its digits grouped by threes: "1,234,567".
pub fn count(count: impl Integer) -> String {
    let count = count.value();
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

/// A count and its noun, with an `s` for any count but one: "1 file", "1,206 files".
pub fn plural(n: impl Integer, singular: &str) -> String {
    plural_as(n, singular, &format!("{singular}s"))
}

/// [`plural`] with its own plural form: "1 copy", "2 copies".
pub fn plural_as(n: impl Integer, singular: &str, plural: &str) -> String {
    let word = if n.value() == 1 { singular } else { plural };
    format!("{} {word}", count(n))
}

/// A time on a clock or a position in a video, in whole seconds: "0:41", "1:02:05".
pub fn clock(time: Duration) -> String {
    let total = time.as_secs();
    let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// A length in milliseconds as a [`clock`], to the nearest second; empty without a length.
pub fn duration(ms: Option<f64>) -> String {
    match ms {
        Some(ms) => clock(Duration::from_secs((ms / 1000.).round().max(0.) as u64)),
        None => String::new(),
    }
}

/// A rough length of time: "40 min", "2 h 40 min".
pub fn span(ms: f64) -> String {
    let minutes = ((ms / 60_000.).round() as i64).max(1);
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let rounded = ((minutes as f64 / 10.).round() as i64) * 10;
    let (hours, rest) = (rounded / 60, rounded % 60);
    if rest == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {rest} min")
    }
}

/// Milliseconds since 1970, as `Date.now()` gives them.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |elapsed| elapsed.as_millis() as f64)
}

/// UTC to the millisecond, as `Date.prototype.toISOString` writes it:
/// `2026-10-29T01:32:29.123Z`.
pub fn iso_timestamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let (days, of_day) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        since.subsec_millis()
    )
}

/// Milliseconds since 1970 of a timestamp [`iso_timestamp`] wrote.
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

/// Howard Hinnant's `civil_from_days`: the proleptic Gregorian date of a day count from 1970.
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

/// A moment's fields in the local time zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl LocalTime {
    const EPOCH: Self = Self {
        year: 1970,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
    };

    fn of_ms(ms: f64) -> Self {
        local_time((ms / 1000.).floor() as i64)
    }

    fn same_day(self, other: Self) -> bool {
        (self.year, self.month, self.day) == (other.year, other.month, other.day)
    }

    /// "2:31 AM", with the seconds when asked for.
    fn time(self, seconds: bool) -> String {
        let hour = match self.hour % 12 {
            0 => 12,
            hour => hour,
        };
        let half = if self.hour < 12 { "AM" } else { "PM" };
        if seconds {
            format!("{hour}:{:02}:{:02} {half}", self.minute, self.second)
        } else {
            format!("{hour}:{:02} {half}", self.minute)
        }
    }

    /// "Oct 29, 2026".
    fn date(self) -> String {
        format!(
            "{} {}, {}",
            MONTHS[self.month as usize - 1],
            self.day,
            self.year
        )
    }
}

/// Local time at `seconds` from 1970, negative before it, as JavaScript's `Date` getters read it:
/// from the C library, in the zone and with the daylight saving rules the system's clock shows.
#[cfg(unix)]
pub fn local_time(seconds: i64) -> LocalTime {
    let seconds = seconds as libc::time_t;
    // SAFETY: `tm` is plain data; `localtime_r` fills it from `seconds` and is thread-safe.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call.
    let filled = unsafe { !libc::localtime_r(&seconds, &mut tm).is_null() };
    if !filled {
        return LocalTime::EPOCH;
    }
    LocalTime {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// Local time at `seconds` from 1970 on Windows, in the zone and with the daylight saving rules
/// Windows' clock shows, as JavaScript's `Date` getters read them there. The C library's
/// `localtime_s` would read a `TZ` variable as POSIX spells it, which Node does not. A `FILETIME`
/// starts in 1601, so anything earlier, or too far ahead for one, gives 1970.
#[cfg(windows)]
pub fn local_time(seconds: i64) -> LocalTime {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{
        DYNAMIC_TIME_ZONE_INFORMATION, FileTimeToSystemTime, GetDynamicTimeZoneInformation,
        SystemTimeToTzSpecificLocalTimeEx,
    };

    /// Seconds from 1601 to 1970.
    const EPOCH_DIFFERENCE: i64 = 11_644_473_600;
    let ticks = seconds
        .checked_add(EPOCH_DIFFERENCE)
        .and_then(|since_1601| since_1601.checked_mul(10_000_000))
        .and_then(|ticks| u64::try_from(ticks).ok());
    let Some(ticks) = ticks else {
        return LocalTime::EPOCH;
    };
    let file_time = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    // SAFETY: plain data, filled by the calls on success.
    let (mut utc, mut local): (SYSTEMTIME, SYSTEMTIME) = unsafe { std::mem::zeroed() };
    // SAFETY: plain data, filled by the call.
    let mut zone: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is valid for its call.
    let filled = unsafe {
        GetDynamicTimeZoneInformation(&raw mut zone) != u32::MAX
            && FileTimeToSystemTime(&raw const file_time, &raw mut utc) != 0
            && SystemTimeToTzSpecificLocalTimeEx(&raw const zone, &raw const utc, &raw mut local)
                != 0
    };
    if !filled {
        return LocalTime::EPOCH;
    }
    LocalTime {
        year: i32::from(local.wYear),
        month: u32::from(local.wMonth),
        day: u32::from(local.wDay),
        hour: u32::from(local.wHour),
        minute: u32::from(local.wMinute),
        second: u32::from(local.wSecond),
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The local date of `ms` from 1970, as `Intl.DateTimeFormat`'s medium date writes it in
/// English: "Oct 29, 2026".
pub fn date(ms: impl Number) -> String {
    LocalTime::of_ms(ms.value()).date()
}

/// The local time of day: "2:31 AM".
pub fn time(ms: impl Number) -> String {
    LocalTime::of_ms(ms.value()).time(false)
}

/// "Oct 29, 2026, 2:31 AM".
pub fn date_time(ms: impl Number) -> String {
    let at = LocalTime::of_ms(ms.value());
    format!("{}, {}", at.date(), at.time(false))
}

/// "Oct 29, 2026, 2:31:05 AM", for telling apart times that share a minute.
pub fn date_time_seconds(ms: impl Number) -> String {
    let at = LocalTime::of_ms(ms.value());
    format!("{}, {}", at.date(), at.time(true))
}

/// "Today", "Yesterday", or the date, for grouping by day.
pub fn day(ms: impl Number, now: f64) -> String {
    let at = LocalTime::of_ms(ms.value());
    if at.same_day(LocalTime::of_ms(now)) {
        "Today".into()
    } else if at.same_day(LocalTime::of_ms(now - 86_400_000.)) {
        "Yesterday".into()
    } else {
        at.date()
    }
}

/// How long ago `ms` was: "just now", "5 min ago", "3 h ago", or the date from a day back;
/// "never" without a time.
pub fn relative(ms: Option<f64>, now: f64) -> String {
    let Some(ms) = ms else {
        return "never".into();
    };
    let minutes = ((now - ms) / 60_000.).round() as i64;
    if minutes < 1 {
        return "just now".into();
    }
    if minutes < 60 {
        return format!("{minutes} min ago");
    }
    let hours = (minutes as f64 / 60.).round() as i64;
    if hours < 24 {
        format!("{hours} h ago")
    } else {
        date(ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_in_decimal_units() {
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(999.), "999 B");
        assert_eq!(bytes(1_250), "1.3 KB");
        assert_eq!(bytes(1_500.), "1.5 KB");
        assert_eq!(bytes(84_640), "84.6 KB");
        assert_eq!(bytes(99_960), "100 KB");
        assert_eq!(bytes(250_000_000_i64), "250 MB");
        assert_eq!(bytes(999_960), "1.0 MB");
        assert_eq!(bytes(1_159_079_u64), "1.2 MB");
        assert_eq!(bytes(5e12), "5.0 TB");
        assert_eq!(bytes(-1_500.), "-1.5 KB");
    }

    #[test]
    fn counts_group_their_digits() {
        assert_eq!(count(0), "0");
        assert_eq!(count(999), "999");
        assert_eq!(count(21_135_usize), "21,135");
        assert_eq!(count(-1_000), "-1,000");
        assert_eq!(count(1_234_567_u64), "1,234,567");
        assert_eq!(plural(1, "file"), "1 file");
        assert_eq!(plural(1206, "file"), "1,206 files");
        assert_eq!(plural_as(2, "copy", "copies"), "2 copies");
    }

    #[test]
    fn lengths_of_time() {
        assert_eq!(clock(Duration::ZERO), "0:00");
        assert_eq!(clock(Duration::from_secs(3599)), "59:59");
        assert_eq!(clock(Duration::from_millis(59_999)), "0:59");
        assert_eq!(clock(Duration::from_secs(3725)), "1:02:05");
        assert_eq!(duration(Some(65_000.)), "1:05");
        assert_eq!(duration(Some(40_600.)), "0:41");
        assert_eq!(duration(None), "");
        assert_eq!(span(30_000.), "1 min");
        assert_eq!(span(9_600_000.), "2 h 40 min");
        assert_eq!(relative(None, 0.), "never");
        assert_eq!(relative(Some(0.), 20_000.), "just now");
        assert_eq!(relative(Some(0.), 300_000.), "5 min ago");
        assert_eq!(relative(Some(0.), 3. * 3_600_000.), "3 h ago");
    }

    #[test]
    fn iso_timestamps_read_back() {
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
}
