//! Checks `still-policy.ts`'s port against `conformance/media-format/still-policy.json`.

mod support;

use oriel_core_format::{
    ArchiveImageFormat, ArchiveImageSource, get_expected_archive_target, plan_archive_image,
    plan_archive_media,
};
use serde::Deserialize;
use serde_json::Value;
use support::{check, fail_with, json, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StillVectors {
    expected_targets: Vec<TargetCase>,
    media: Vec<MediaCase>,
    images: Vec<ImageCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetCase {
    file_name: String,
    target: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaCase {
    file_name: String,
    mime_type: String,
    /// The TypeScript's plan as JSON, so its form is checked too.
    plan: Value,
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
fn expects_the_targets_the_typescript_expects() {
    let mut problems = Vec::new();
    for case in &vectors().expected_targets {
        check(
            &mut problems,
            || format!("getExpectedArchiveTarget({:?})", case.file_name),
            &case.target,
            &get_expected_archive_target(&case.file_name),
        );
    }
    fail_with(&problems, "targets differ");
}

#[test]
fn plans_downloads_by_name_and_mime_type_as_the_typescript_does() {
    let mut problems = Vec::new();
    for case in &vectors().media {
        check(
            &mut problems,
            || {
                format!(
                    "planArchiveMedia({:?}, {:?})",
                    case.file_name, case.mime_type
                )
            },
            &case.plan,
            &json(&plan_archive_media(&case.file_name, &case.mime_type)),
        );
    }
    fail_with(&problems, "download plans differ");
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
