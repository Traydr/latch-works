//! Checks `avif.ts`'s settings and fallback against `conformance/media-format/avif.json`.

mod support;

use oriel_core_format::{
    ARCHIVE_AVIF_LOW_MEMORY_SPEED, ARCHIVE_AVIF_OPTIONS, ARCHIVE_AVIF_QUALITY,
    ARCHIVE_AVIF_SHARP_OPTIONS, ARCHIVE_AVIF_SPEED, ARCHIVE_AVIF_WASM_PIXEL_LIMIT,
    AvifEncodeOptions, encode_archive_avif,
};
use serde::Deserialize;
use serde_json::Value;
use support::{check, fail_with, json, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvifVectors {
    quality: i32,
    speed: i32,
    low_memory_speed: i32,
    wasm_pixel_limit: u64,
    options: Value,
    sharp_options: Value,
    attempts: Vec<AttemptCase>,
}

#[derive(Deserialize)]
struct AttemptCase {
    script: Vec<AttemptResult>,
    calls: Vec<AvifEncodeOptions>,
    outcome: Outcome,
}

/// What the scripted encoder does on each call.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AttemptResult {
    Encodes,
    ReturnsNothing,
    Throws,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Outcome {
    Encoded {
        bytes: usize,
    },
    /// The TypeScript also reports the error's class, `MediaEncodeError`, which Rust has no
    /// counterpart for: the encoder's own error comes back.
    Failed {
        message: String,
    },
}

fn vectors() -> AvifVectors {
    read_vectors("avif.json")
}

#[test]
fn encodes_with_the_settings_the_typescript_uses() {
    let vectors = vectors();
    assert_eq!(vectors.quality, ARCHIVE_AVIF_QUALITY);
    assert_eq!(vectors.speed, ARCHIVE_AVIF_SPEED);
    assert_eq!(vectors.low_memory_speed, ARCHIVE_AVIF_LOW_MEMORY_SPEED);
    assert_eq!(vectors.wasm_pixel_limit, ARCHIVE_AVIF_WASM_PIXEL_LIMIT);
    assert_eq!(vectors.options, json(&ARCHIVE_AVIF_OPTIONS));
    assert_eq!(vectors.sharp_options, json(&ARCHIVE_AVIF_SHARP_OPTIONS));
}

#[test]
fn falls_back_to_the_low_memory_speed_once_as_the_typescript_does() {
    let mut problems = Vec::new();
    for case in &vectors().attempts {
        let mut calls = Vec::new();
        let result = encode_archive_avif(|options| {
            calls.push(*options);
            // The TypeScript's scripted codec encodes three bytes, or fails as the wasm codec
            // does: by returning nothing, or by trapping.
            match case.script.get(calls.len() - 1) {
                Some(AttemptResult::Encodes) | None => Ok(3),
                Some(AttemptResult::ReturnsNothing) => {
                    Err("The AVIF encoder did not produce an image.".to_owned())
                }
                Some(AttemptResult::Throws) => Err("memory access out of bounds".to_owned()),
            }
        });
        let outcome = match result {
            Ok(bytes) => Outcome::Encoded { bytes },
            Err(message) => Outcome::Failed { message },
        };
        let what = || format!("the script {:?}", case.script);
        check(&mut problems, what, &case.calls, &calls);
        check(&mut problems, what, &case.outcome, &outcome);
    }
    fail_with(&problems, "fallbacks differ");
}
