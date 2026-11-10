//! Checks the plan for images on disk against `conformance/media-format/still-policy.json`, a
//! frozen fixture: only Oriel runs this rule.

use crate::support::{check, fail_with, json, read_vectors};
use oriel_core_format::{ArchiveImageFormat, ArchiveImageSource, plan_archive_image};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StillVectors {
    images: Vec<ImageCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageCase {
    file_name: String,
    format: ArchiveImageFormat,
    frame_count: u32,
    plan: Value,
}

fn vectors() -> StillVectors {
    read_vectors("still-policy.json")
}

#[test]
fn plans_images_on_disk_as_the_typescript_does() {
    let mut problems = Vec::new();
    for case in &vectors().images {
        let source = ArchiveImageSource {
            file_name: &case.file_name,
            format: case.format,
            frame_count: case.frame_count,
        };
        check(
            &mut problems,
            || format!("planArchiveImage({source:?})"),
            &case.plan,
            &json(&plan_archive_image(&source)),
        );
    }
    fail_with(&problems, "image plans differ");
}
