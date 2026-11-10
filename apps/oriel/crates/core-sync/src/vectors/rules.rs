//! `rules.json`, the small rules push and the doctor apply: content types, registrations, the
//! upload queue's width and where a plan's path is on disk.

use std::path::Path;

use oriel_core_domain::{get_base_name, get_extension};
use serde::Deserialize;

use super::read_vectors;
use crate::rules::{
    content_type_for_extension, resolve_local_file_path, resolve_upload_concurrency,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulesVectors {
    content_types: Vec<ContentTypeCase>,
    registrations: Vec<RegistrationCase>,
    upload_concurrency: Vec<ConcurrencyCase>,
    local_paths: Vec<LocalPathCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentTypeCase {
    extension: String,
    content_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationCase {
    logical_path: String,
    filename: String,
    extension: String,
    content_type: String,
}

#[derive(Deserialize)]
struct ConcurrencyCase {
    value: Option<f64>,
    resolved: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPathCase {
    archive_path: String,
    resolved: Option<String>,
}

#[test]
#[cfg_attr(
    windows,
    ignore = "the vectors hold the POSIX paths Node writes on macOS"
)]
fn applies_lockstep_cores_rules() {
    let vectors: RulesVectors = read_vectors("rules.json");
    for case in vectors.content_types {
        assert_eq!(
            content_type_for_extension(&case.extension),
            case.content_type,
            "{}",
            case.extension
        );
    }
    for case in vectors.registrations {
        let filename = get_base_name(&case.logical_path);
        let extension = get_extension(&filename);
        assert_eq!(filename, case.filename, "{}", case.logical_path);
        assert_eq!(extension, case.extension, "{}", case.logical_path);
        assert_eq!(content_type_for_extension(&extension), case.content_type);
    }
    for case in vectors.upload_concurrency {
        // A fraction or a negative never reaches Rust's `usize`; it is refused as TypeScript
        // refuses it.
        let resolved = match case.value {
            None => resolve_upload_concurrency(None).ok(),
            Some(value) if value >= 0.0 && value.fract() == 0.0 => {
                resolve_upload_concurrency(Some(value as usize)).ok()
            }
            Some(_) => None,
        };
        assert_eq!(
            resolved, case.resolved,
            "upload concurrency {:?}",
            case.value
        );
    }
    for case in vectors.local_paths {
        let resolved = resolve_local_file_path(Path::new("/archive/root"), &case.archive_path)
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        assert_eq!(resolved, case.resolved, "{:?}", case.archive_path);
    }
}
