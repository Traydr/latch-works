//! Checks `system-files.ts`'s port against `conformance/media-domain/system-files.json`.

mod support;

use oriel_core_domain::{
    GLAZIER_HOLDING_DIRECTORY_NAME, LATCH_WORKS_DIRECTORY_NAME, is_system_junk_directory,
    is_system_junk_file,
};
use serde::Deserialize;
use support::{GeneratedWith, check, describe, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemFileVectors {
    generated_with: GeneratedWith,
    latch_works_directory_name: String,
    glazier_holding_directory_name: String,
    names: Vec<NameCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameCase {
    name: String,
    junk_file: bool,
    junk_directory: bool,
}

#[test]
fn skips_the_files_and_folders_the_typescript_skips() {
    let vectors: SystemFileVectors = read_vectors("system-files.json");
    assert_eq!(
        vectors.latch_works_directory_name,
        LATCH_WORKS_DIRECTORY_NAME
    );
    assert_eq!(
        vectors.glazier_holding_directory_name,
        GLAZIER_HOLDING_DIRECTORY_NAME
    );

    let mut problems = Vec::new();
    for case in &vectors.names {
        check(
            &mut problems,
            || format!("isSystemJunkFile({})", describe(&case.name)),
            &case.junk_file,
            &is_system_junk_file(&case.name),
        );
        check(
            &mut problems,
            || format!("isSystemJunkDirectory({})", describe(&case.name)),
            &case.junk_directory,
            &is_system_junk_directory(&case.name),
        );
    }
    fail_with(
        &problems,
        "names are judged differently",
        &vectors.generated_with,
    );
}
