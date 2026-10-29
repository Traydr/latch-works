//! glazier-core's rules up to changing files, against the vectors its own suite writes
//! (`packages/glazier-core/src/conformance.test.ts`): sniffing, the junk rules, the keeper,
//! similar groups, duplicate sets with Spot variants, Convert's candidates and Shrink's estimate,
//! and how ffprobe's JSON is read. A difference here is a rule that drifted between the two apps.

#[path = "support/report.rs"]
mod report;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_tidy::catalog::Catalog;
use oriel_core_tidy::catalog::files::initial_kind;
use oriel_core_tidy::catalog::roots::write_settings;
use oriel_core_tidy::contract::{
    DuplicateScope, FileFormat, FileKind, KeepReason, Settings, SimilarityLevel,
};
use oriel_core_tidy::duplicates::{
    ComputedSet, Dismissals, KeeperCandidate, PageRequest, add_dismissal, build_duplicate_sets,
    compute_similar_clusters, page_duplicate_sets, rank_keepers,
};
use oriel_core_tidy::media::parse_video_probe;
use oriel_core_tidy::optimize::candidates::skip_counts;
use oriel_core_tidy::optimize::{
    CandidateHolds, encode_speed, extension_fixes, find_optimize_candidates,
    find_shrink_candidates, summarize_candidates,
};
use oriel_core_tidy::scan::{
    extension_of, format_extensions, is_extension_mismatch, is_folder_system_file, kind_for_format,
    preferred_extension, sniff_bytes,
};
use oriel_core_tidy::similarity::{Fingerprint, FingerprintedFile, group_similar_files};
use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};

fn vectors(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/glazier-core")
        .join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("Malformed {name}: {error}"))
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string in the vectors")
}

/// Fails with every difference between what the vectors hold and what Rust made.
fn assert_same(what: &str, expected: &Value, made: &Value) {
    let differences = report::differences(expected, made);
    assert!(
        differences.is_empty(),
        "{what}: {} differences from glazier-core:\n{}",
        differences.len(),
        differences
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn sniffing_names_formats_extensions_and_kinds_as_glazier_core() {
    let vectors = vectors("sniff.json");
    for case in vectors["bytes"].as_array().unwrap() {
        let bytes = from_hex(text(&case["hex"]));
        assert_eq!(
            sniff_bytes(&bytes).as_str(),
            text(&case["format"]),
            "the format of {}",
            text(&case["hex"])
        );
    }
    let extensions: Vec<&str> = vectors["extensions"]
        .as_array()
        .unwrap()
        .iter()
        .map(text)
        .collect();
    for case in vectors["formats"].as_array().unwrap() {
        let format = FileFormat::parse(text(&case["format"])).unwrap();
        assert_eq!(kind_for_format(format).as_str(), text(&case["kind"]));
        assert_eq!(
            json!(preferred_extension(format)),
            case["preferred"],
            "{format}"
        );
        let mismatches: Vec<&str> = extensions
            .iter()
            .copied()
            .filter(|extension| is_extension_mismatch(format, extension))
            .collect();
        assert_eq!(
            json!(mismatches),
            case["mismatches"],
            "mismatches of {format}"
        );
        assert!(
            format_extensions(format)
                .iter()
                .all(|e| e.to_lowercase() == *e)
        );
    }
}

#[test]
fn the_scan_tells_junk_extensions_and_first_kinds_apart_as_glazier_core() {
    for case in vectors("scan-rules.json")["names"].as_array().unwrap() {
        let name = text(&case["name"]);
        let junk = oriel_core_domain::is_system_junk_file(name);
        let made = json!({
            "name": name,
            "folderSystemFile": is_folder_system_file(name),
            "systemJunkFile": junk,
            "extension": extension_of(name),
            "kind": initial_kind(name, false),
            "walkedKind": initial_kind(name, junk),
        });
        assert_same(name, case, &made);
    }
}

#[test]
fn the_keeper_ranks_copies_as_glazier_core() {
    for (index, group) in vectors("keeper.json")["groups"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let candidates: Vec<KeeperCandidate> =
            serde_json::from_value(group["candidates"].clone()).unwrap();
        let (ranked, reason) = rank_keepers(&candidates);
        let ids: Vec<i64> = ranked.iter().map(|candidate| candidate.id).collect();
        assert_eq!(json!(ids), group["ranked"], "the order of group {index}");
        let expected: Option<KeepReason> = serde_json::from_value(group["reason"].clone()).unwrap();
        assert_eq!(reason, expected, "the reason of group {index}");
    }
}

#[test]
fn similar_groups_form_at_each_level_as_glazier_cores() {
    for case in vectors("similar-groups.json")["cases"].as_array().unwrap() {
        let files: Vec<FingerprintedFile> = case["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| FingerprintedFile {
                id: file["id"].as_i64().unwrap(),
                aspect: file["aspect"].as_f64().unwrap(),
                fingerprint: Fingerprint::parse(text(&file["fingerprint"])).unwrap(),
            })
            .collect();
        for level in SimilarityLevel::ALL {
            let made = serde_json::to_value(group_similar_files(&files, *level)).unwrap();
            assert_same(
                &format!("{} at {level}", text(&case["name"])),
                &case["levels"][level.as_str()],
                &made,
            );
        }
    }
}

/// A scratch catalog filled as the vector suite fills its own.
struct Synthetic {
    catalog: Catalog,
    folder: PathBuf,
}

impl Drop for Synthetic {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

/// A JSON value bound as `node:sqlite` binds it: every number as a double.
fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Number(number) => SqlValue::Real(number.as_f64().unwrap()),
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        other => panic!("No column holds {other}"),
    }
}

fn synthetic(case: &Value) -> Synthetic {
    let folder = std::env::temp_dir().join(format!(
        "oriel-tidy-vectors-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&folder).unwrap();
    let catalog = Catalog::open_blocking(folder.join("catalog.sqlite")).unwrap();
    let case = case.clone();
    catalog
        .blocking(move |connection| {
            connection.execute_batch(
                "INSERT INTO roots (id, path, added_at) VALUES (1, '/archive', 0);
                 INSERT INTO roots (id, path, added_at) VALUES (2, '/other', 0);",
            )?;
            let settings: Settings = serde_json::from_value(case["settings"].clone())?;
            write_settings(connection, &settings)?;
            let rows = case["rows"].as_array().unwrap();
            for row in rows {
                let object = row.as_object().unwrap();
                let columns: Vec<&String> = object.keys().collect();
                let sql = format!(
                    "INSERT INTO files ({}) VALUES ({})",
                    columns
                        .iter()
                        .map(|column| column.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    (1..=columns.len())
                        .map(|index| format!("?{index}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let values: Vec<SqlValue> = object.values().map(sql_value).collect();
                connection.execute(&sql, rusqlite::params_from_iter(values))?;
            }
            for detail in case["details"].as_array().unwrap() {
                let id = detail["fileId"].as_i64().unwrap();
                let row = rows
                    .iter()
                    .find(|row| row["id"].as_i64() == Some(id))
                    .unwrap();
                let print = detail["print"].as_str().map(from_hex);
                connection.execute(
                    "INSERT INTO file_details (file_id, version, size, mtime_ms, print, error)
                     VALUES (?1, 1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        id as f64,
                        sql_value(&row["size"]),
                        sql_value(&row["mtime_ms"]),
                        print,
                        detail["print"].is_null().then_some("no print")
                    ],
                )?;
            }
            for files in case["dismissals"].as_array().unwrap() {
                let ids: Vec<i64> = serde_json::from_value(files.clone())?;
                add_dismissal(connection, &ids, None)?;
            }
            for (index, timing) in case["timings"].as_array().unwrap().iter().enumerate() {
                connection.execute(
                    "INSERT INTO encode_timings (id, encoder, pixels, media_ms, wall_ms, at)
                     VALUES (?1, 'svt-av1', ?2, ?3, ?4, 0)",
                    rusqlite::params![
                        (index + 1) as f64,
                        sql_value(&timing["pixels"]),
                        sql_value(&timing["mediaMs"]),
                        sql_value(&timing["wallMs"])
                    ],
                )?;
            }
            Ok(())
        })
        .unwrap();
    Synthetic { catalog, folder }
}

/// A computed set as glazier-core writes one: its set has no dismissal yet.
fn computed_json(set: &ComputedSet) -> Value {
    let mut inner = serde_json::to_value(&set.set).unwrap();
    inner.as_object_mut().unwrap().remove("dismissalId");
    json!({
        "set": inner,
        "fileIds": set.file_ids,
        "extraCopies": set.extra_copies,
        "variants": set.variants,
        "comparable": set.comparable,
        "compared": set.compared,
    })
}

#[test]
fn duplicate_sets_keepers_and_pictures_are_glazier_cores() {
    for case in vectors("duplicate-sets.json")["cases"].as_array().unwrap() {
        let name = text(&case["name"]).to_owned();
        let synthetic = synthetic(case);
        let settings: Settings = serde_json::from_value(case["settings"].clone()).unwrap();
        for (key, expected) in case["levels"].as_object().unwrap() {
            let (level, root) = key.split_once(':').unwrap();
            let level = SimilarityLevel::parse(level).unwrap();
            let root_id = (root != "all").then(|| root.parse::<i64>().unwrap());
            let settings = settings.clone();
            let made = synthetic
                .catalog
                .blocking(move |connection| {
                    let clusters = compute_similar_clusters(connection, root_id, level)?;
                    let computed = build_duplicate_sets(connection, root_id, &settings, &clusters)?;
                    let dismissals = Dismissals::load(connection)?;
                    let mut pages = serde_json::Map::new();
                    for scope in DuplicateScope::ALL {
                        for dismissed in [false, true] {
                            let page = page_duplicate_sets(
                                &computed,
                                &dismissals,
                                PageRequest {
                                    scope: *scope,
                                    dismissed,
                                    offset: 0,
                                    limit: 100,
                                },
                            );
                            let mut value = serde_json::to_value(&page)?;
                            let object = value.as_object_mut().unwrap();
                            object.remove("fingerprinted");
                            object.remove("fingerprintable");
                            object.insert(
                                "sets".into(),
                                json!(
                                    page.sets
                                        .iter()
                                        .map(|set| json!({
                                            "key": set.key,
                                            "dismissalId": set.dismissal_id,
                                        }))
                                        .collect::<Vec<_>>()
                                ),
                            );
                            let label = format!(
                                "{}{}",
                                scope.as_str(),
                                if dismissed { "-dismissed" } else { "" }
                            );
                            pages.insert(label, value);
                        }
                    }
                    Ok(json!({
                        "clusters": clusters,
                        "computed": computed.iter().map(computed_json).collect::<Vec<_>>(),
                        "pages": pages,
                    }))
                })
                .unwrap();
            assert_same(&format!("{name} at {key}"), expected, &made);
        }
    }
}

#[test]
fn convert_candidates_and_shrink_estimates_are_glazier_cores() {
    for case in vectors("optimize.json")["cases"].as_array().unwrap() {
        let name = text(&case["name"]).to_owned();
        let synthetic = synthetic(case);
        let auto_analyze = case["settings"]["autoAnalyze"].as_bool().unwrap();
        let made = synthetic
            .catalog
            .blocking(move |connection| {
                let holds = [
                    CandidateHolds::default(),
                    CandidateHolds {
                        reviewing: HashSet::from([2]),
                        wait_for_fingerprints: auto_analyze,
                    },
                ];
                let mut convert = Vec::new();
                let mut shrink = Vec::new();
                for holds in &holds {
                    let scan = find_optimize_candidates(connection, 1, holds)?;
                    let fixes = extension_fixes(connection, 1, &scan.candidates)?;
                    convert.push(json!({
                        "summary": summarize_candidates(&scan),
                        "candidates": scan.candidates.iter().map(|candidate| json!({
                            "id": candidate.record.id,
                            "category": candidate.category,
                            "targetName": candidate.target_name,
                        })).collect::<Vec<_>>(),
                        "extensionFixes": fixes.iter().map(|(record, name)| json!({
                            "id": record.id,
                            "name": name,
                        })).collect::<Vec<_>>(),
                    }));
                    let scan = find_shrink_candidates(connection, 1, holds)?;
                    shrink.push(json!({
                        "items": scan.candidates.iter().map(|c| &c.item).collect::<Vec<_>>(),
                        "skipped": skip_counts(&scan.skipped),
                        "speedMeasured": scan.speed_measured,
                    }));
                }
                let speed = encode_speed(connection)?;
                Ok((convert, shrink, speed))
            })
            .unwrap();
        let (convert, shrink, speed) = made;
        assert_same(
            &format!("{name}: Convert"),
            &case["convert"],
            &json!(convert),
        );
        assert_same(&format!("{name}: Shrink"), &case["shrink"], &json!(shrink));
        for sample in case["speeds"].as_array().unwrap() {
            let pixels = sample["pixels"].as_f64().unwrap();
            assert_eq!(
                speed.at(pixels),
                sample["speed"].as_f64().unwrap(),
                "{name}: the speed at {pixels} pixels"
            );
        }
    }
}

#[test]
fn ffprobes_json_is_read_as_glazier_core_reads_it() {
    for case in vectors("video-probe.json")["cases"].as_array().unwrap() {
        let probe = parse_video_probe(text(&case["stdout"])).unwrap();
        assert_same(
            text(&case["name"]),
            &case["probe"],
            &serde_json::to_value(probe).unwrap(),
        );
    }
}

#[test]
fn kinds_round_trip_through_their_names() {
    for kind in FileKind::ALL {
        assert_eq!(FileKind::parse(kind.as_str()), Some(*kind));
    }
    for format in FileFormat::ALL {
        assert_eq!(FileFormat::parse(format.as_str()), Some(*format));
    }
}
