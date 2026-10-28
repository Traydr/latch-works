//! Checks `paths.ts`'s port against `conformance/media-domain/paths.json`.

mod support;

use oriel_core_domain::{
    canonicalize_extension, display_name_from_path, format_bytes, get_base_name, get_parent_path,
    join_archive_path, normalize_path_for_compare, normalize_path_for_compare_keeping_extensions,
    pair_sync_paths, to_archive_path, trim_trailing_slash,
};
use serde::Deserialize;
use support::{GeneratedWith, check, describe, fail_with, read_vectors};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathVectors {
    generated_with: GeneratedWith,
    paths: Vec<PathCase>,
    extensions: Vec<ExtensionCase>,
    joins: Vec<JoinCase>,
    pairs: Vec<PairCase>,
    format_bytes: Vec<BytesCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathCase {
    path: String,
    archive_path: String,
    without_trailing_slash: String,
    parent_path: String,
    base_name: String,
    display_name: String,
    comparable: String,
    comparable_as_written: String,
}

#[derive(Deserialize)]
struct ExtensionCase {
    extension: String,
    canonical: String,
}

#[derive(Deserialize)]
struct JoinCase {
    parts: Vec<String>,
    joined: String,
}

#[derive(Deserialize)]
struct PairCase {
    about: String,
    locals: Vec<String>,
    remotes: Vec<String>,
    pairs: Vec<(String, String)>,
}

#[derive(Deserialize)]
struct BytesCase {
    bytes: f64,
    formatted: String,
}

fn vectors() -> PathVectors {
    read_vectors("paths.json")
}

#[test]
fn normalizes_splits_and_compares_paths_as_the_typescript_does() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for case in &vectors.paths {
        let path = case.path.as_str();
        let results: [(&str, &String, String); 7] = [
            ("toArchivePath", &case.archive_path, to_archive_path(path)),
            (
                "trimTrailingSlash",
                &case.without_trailing_slash,
                trim_trailing_slash(path).to_owned(),
            ),
            ("getParentPath", &case.parent_path, get_parent_path(path)),
            ("getBaseName", &case.base_name, get_base_name(path)),
            (
                "displayNameFromPath",
                &case.display_name,
                display_name_from_path(path),
            ),
            (
                "normalizePathForCompare",
                &case.comparable,
                normalize_path_for_compare(path),
            ),
            (
                "normalizePathForCompare without aliases",
                &case.comparable_as_written,
                normalize_path_for_compare_keeping_extensions(path),
            ),
        ];
        for (function, typescript, rust) in results {
            check(
                &mut problems,
                || format!("{function}({})", describe(path)),
                typescript,
                &rust,
            );
        }
    }
    fail_with(&problems, "paths differ", &vectors.generated_with);
}

#[test]
fn canonicalizes_extensions_and_joins_paths_as_the_typescript_does() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for case in &vectors.extensions {
        check(
            &mut problems,
            || format!("canonicalizeExtension({})", describe(&case.extension)),
            &case.canonical,
            &canonicalize_extension(&case.extension),
        );
    }
    for case in &vectors.joins {
        check(
            &mut problems,
            || format!("joinArchivePath({:?})", case.parts),
            &case.joined,
            &join_archive_path(&case.parts),
        );
    }
    fail_with(
        &problems,
        "extensions or joins differ",
        &vectors.generated_with,
    );
}

#[test]
fn pairs_sync_paths_as_the_typescript_does_in_its_order() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for case in &vectors.pairs {
        let rust: Vec<(String, String)> = pair_sync_paths(&case.locals, &case.remotes)
            .into_iter()
            .map(|(local, remote)| (local.to_owned(), remote.to_owned()))
            .collect();
        check(&mut problems, || case.about.clone(), &case.pairs, &rust);
    }
    fail_with(&problems, "pairings differ", &vectors.generated_with);
}

#[test]
fn formats_byte_counts_as_the_typescript_does() {
    let vectors = vectors();
    let mut problems = Vec::new();
    for case in &vectors.format_bytes {
        check(
            &mut problems,
            || format!("formatBytes({:?})", case.bytes),
            &case.formatted,
            &format_bytes(case.bytes),
        );
    }
    fail_with(
        &problems,
        "byte counts format differently",
        &vectors.generated_with,
    );
}
