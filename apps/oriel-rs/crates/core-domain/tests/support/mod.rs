//! What the conformance tests share: reading a vector file, and showing strings in failures.
//!
//! The vectors are made from the TypeScript, never by hand (each file's `about` says how), so a
//! failure is a difference between the two implementations.

// Each test binary uses part of this.
#![allow(dead_code)]

use std::{fs, path::Path};

use serde::{Deserialize, de::DeserializeOwned};

/// The runtime that made a file. Case mapping, NFC and collation follow its Unicode data.
#[derive(Deserialize)]
pub struct GeneratedWith {
    pub node: String,
    pub icu: String,
    pub unicode: String,
}

impl GeneratedWith {
    /// The versions, for a failure message: a difference on a character Unicode added recently
    /// can be the two sides' data rather than their code.
    pub fn versions(&self) -> String {
        let (major, minor, update) = char::UNICODE_VERSION;
        format!(
            "vectors from Node {} (ICU {}, Unicode {}); Rust's char tables are Unicode \
             {major}.{minor}.{update}",
            self.node, self.icu, self.unicode
        )
    }
}

pub fn read_vectors<T: DeserializeOwned>(file_name: &str) -> T {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/media-domain")
        .join(file_name);
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("{} does not parse: {error}", file.display()))
}

/// A string as a failure shows it: escaped, cut short when long, with its code points, since
/// many of the corpus's names are invisible or differ only in normalization.
pub fn describe(value: &str) -> String {
    let count = value.chars().count();
    let shown: String = value.chars().take(24).collect();
    let code_points: Vec<String> = value
        .chars()
        .take(24)
        .map(|character| format!("U+{:04X}", u32::from(character)))
        .collect();
    let more = if count > 24 {
        format!(" ... ({count} characters)")
    } else {
        String::new()
    };
    format!("{shown:?}{more} [{}]", code_points.join(" "))
}

/// Compares one result, adding a line to `problems` when Rust differs from the TypeScript.
pub fn check<T: PartialEq + std::fmt::Debug>(
    problems: &mut Vec<String>,
    what: impl FnOnce() -> String,
    typescript: &T,
    rust: &T,
) {
    if typescript != rust {
        problems.push(format!(
            "{}:\n  TypeScript {typescript:?}\n  Rust       {rust:?}",
            what()
        ));
    }
}

pub fn fail_with(problems: &[String], what: &str, generated_with: &GeneratedWith) {
    assert!(
        problems.is_empty(),
        "{} {what} ({}):\n{}",
        problems.len(),
        generated_with.versions(),
        problems.join("\n")
    );
}
