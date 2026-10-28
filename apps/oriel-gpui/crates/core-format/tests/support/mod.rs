//! What the conformance tests share: reading a vector file, and collecting differences.
//!
//! The vectors are made from the TypeScript, never by hand (each file's `about` says how), so a
//! failure is a difference between the two implementations.

// Each test binary uses part of this.
#![allow(dead_code)]

use std::{fmt::Debug, fs, path::Path};

use serde::de::DeserializeOwned;

pub fn read_vectors<T: DeserializeOwned>(file_name: &str) -> T {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/media-format")
        .join(file_name);
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("{} does not parse: {error}", file.display()))
}

/// The value as JSON, to compare a Rust result with the TypeScript's in the TypeScript's form.
pub fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).expect("the value serializes")
}

/// Compares one result, adding a line to `problems` when Rust differs from the TypeScript.
pub fn check<T: PartialEq + Debug>(
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

pub fn fail_with(problems: &[String], what: &str) {
    assert!(
        problems.is_empty(),
        "{} {what}:\n{}",
        problems.len(),
        problems.join("\n")
    );
}
