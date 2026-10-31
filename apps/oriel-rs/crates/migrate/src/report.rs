//! What an import brought over, kept in `shell/migration.json` as Electron Oriel keeps what its
//! first start brought over from the old apps in its own `migration.json`. The fields Electron
//! Oriel's report has keep its names and meanings, so either app reads the other's; the areas
//! and the folder moved aside are Oriel RS's own.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The report's file in the shell's folder, as Electron Oriel names its own.
pub const REPORT_FILE: &str = "migration.json";

/// The parts of Oriel RS's data root an import writes, each as a whole folder. `sandbox` is never
/// one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Area {
    Shell,
    View,
    Tidy,
    Sync,
    HashCache,
}

impl Area {
    pub const ALL: [Self; 5] = [
        Self::Shell,
        Self::View,
        Self::Tidy,
        Self::Sync,
        Self::HashCache,
    ];

    /// The area's folder in the data root, as `DataRoot` names it.
    pub fn folder(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::View => "view",
            Self::Tidy => "tidy",
            Self::Sync => "sync",
            Self::HashCache => "hash-cache",
        }
    }

    /// The area's name in the window.
    pub fn label(self) -> &'static str {
        match self {
            Self::Shell => "Window and preferences",
            Self::View => "View",
            Self::Tidy => "Tidy",
            Self::Sync => "Sync",
            Self::HashCache => "Sync's hash cache",
        }
    }
}

impl fmt::Display for Area {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// What came of one area.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaReport {
    pub area: Area,
    /// Its data was copied in, whole.
    pub imported: bool,
    /// What it brought, one short line each: "2 folders", "34 held files (1.2 GB)".
    pub details: Vec<String>,
    /// What it left out, and why, while the rest came over: a cache that did not read.
    pub skipped: Vec<String>,
    /// Why nothing of it came over.
    pub error: Option<String>,
}

impl AreaReport {
    pub(crate) fn new(area: Area) -> Self {
        Self {
            area,
            imported: false,
            details: Vec::new(),
            skipped: Vec::new(),
            error: None,
        }
    }
}

/// Sync's tokens: how many the imported key opens, and how many it does not (a token the old
/// standalone Lockstep saved, which Sync asks for again).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub migrated: u64,
    pub failed: u64,
}

/// One import's report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub ran_at: String,
    /// The home folder (or its stand-in) Electron Oriel's data was read under.
    pub from: String,
    pub tokens: Tokens,
    /// The `localStorage` keys brought over.
    pub preferences: Vec<String>,
    /// Whether the window's size and place came over.
    pub window_state: bool,
    /// Every folder the modes worked on: View's, Tidy's, Sync's, and those Electron Oriel's own
    /// first start found.
    pub folders: Vec<String>,
    /// The old apps removed; Oriel RS removes nothing.
    pub removed: Vec<String>,
    pub areas: Vec<AreaReport>,
    /// Where what Oriel RS had in the areas written went: `<root>/before-import-<time>`.
    pub moved_aside: Option<String>,
}

impl Report {
    /// The report the shell's folder holds, if an import wrote one.
    pub fn read(shell: &Path) -> Option<Self> {
        serde_json::from_str(&std::fs::read_to_string(shell.join(REPORT_FILE)).ok()?).ok()
    }

    pub(crate) fn write(&self, shell: &Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self).expect("a report serializes");
        std::fs::write(shell.join(REPORT_FILE), format!("{text}\n"))
    }

    /// The area's part of the report.
    pub fn area(&self, area: Area) -> Option<&AreaReport> {
        self.areas.iter().find(|report| report.area == area)
    }

    /// The areas that came over, and those that did not.
    pub fn imported(&self) -> impl Iterator<Item = &AreaReport> {
        self.areas.iter().filter(|report| report.imported)
    }

    pub fn failed(&self) -> impl Iterator<Item = &AreaReport> {
        self.areas.iter().filter(|report| report.error.is_some())
    }
}

/// `1.2 GB`, `340 MB`, `12 KB`, as Finder counts them (powers of 1,000).
pub fn bytes(count: u64) -> String {
    const UNITS: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    if count < 1000 {
        return if count == 1 {
            "1 byte".to_owned()
        } else {
            format!("{count} bytes")
        };
    }
    let mut value = count as f64;
    let mut unit = 0;
    while value >= 999.95 && unit < UNITS.len() - 1 {
        value /= 1000.;
        unit += 1;
    }
    if value >= 100. {
        format!("{value:.0} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `1 folder`, `2,345 files`.
pub fn count(value: u64, one: &str, many: &str) -> String {
    let digits = value.to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{grouped} {}", if value == 1 { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_counts_read_plainly() {
        assert_eq!(bytes(0), "0 bytes");
        assert_eq!(bytes(1), "1 byte");
        assert_eq!(bytes(12_345), "12.3 KB");
        assert_eq!(bytes(340_000_000), "340 MB");
        assert_eq!(bytes(1_234_000_000), "1.2 GB");
        assert_eq!(bytes(999_960), "1.0 MB");
        assert_eq!(count(1, "folder", "folders"), "1 folder");
        assert_eq!(count(2_345, "file", "files"), "2,345 files");
        assert_eq!(count(1_000_000, "file", "files"), "1,000,000 files");
    }
}
