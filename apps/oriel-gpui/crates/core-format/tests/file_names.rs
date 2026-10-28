//! Checks `file-names.ts`'s port against `conformance/media-format/file-names.json`.

mod support;

use oriel_core_format::{get_file_extension, replace_file_extension};
use serde::Deserialize;
use support::{check, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileNameVectors {
    names: Vec<NameCase>,
    replacement_extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameCase {
    file_name: String,
    extension: String,
    replaced: Vec<String>,
}

#[test]
fn reads_and_swaps_extensions_as_the_typescript_does() {
    let vectors: FileNameVectors = read_vectors("file-names.json");
    let mut problems = Vec::new();
    for case in &vectors.names {
        check(
            &mut problems,
            || format!("getFileExtension({:?})", case.file_name),
            &case.extension,
            &get_file_extension(&case.file_name),
        );
        let replaced: Vec<String> = vectors
            .replacement_extensions
            .iter()
            .map(|extension| replace_file_extension(&case.file_name, extension))
            .collect();
        check(
            &mut problems,
            || {
                format!(
                    "replaceFileExtension({:?}, each of {:?})",
                    case.file_name, vectors.replacement_extensions
                )
            },
            &case.replaced,
            &replaced,
        );
    }
    fail_with(&problems, "file names differ");
}
