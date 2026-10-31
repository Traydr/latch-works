//! The changes differential's Rust half: replays the decisions glazier-core made in each scenario
//! (its `test-support/changes.ts`) through this engine, on its own copy of
//! the archive, and reports what each left in the form glazier-core's report has, so the two can
//! be compared.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    FileFilter, FileQuery, FileSortColumn, HoldingRequest, OptimizeCategory, PlanListRequest,
    PlanRequest, PlanStepsRequest, Root, RootId,
};
use oriel_core_tidy::media::probe_video;
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_core_tidy::scan::sniff_file;
use oriel_core_tidy::{FollowUp, TidyEngine};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

/// One scenario's engine, root and archive.
pub struct Replay {
    pub engine: TidyEngine,
    pub root: Root,
    pub data_dir: PathBuf,
    pub media: Media,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Replay {
    /// A fresh engine on `scratch/data`, with `archive` added and scanned (and analysed).
    pub fn open(scratch: &Path, archive: &Path, media: Media) -> Self {
        let data = DataRoot::at(scratch.join("data")).unwrap();
        let engine = block_on(TidyEngine::open_with(
            data.clone(),
            data.tidy().join("catalog.sqlite"),
            media.clone(),
        ))
        .unwrap();
        let root = block_on(engine.add_root(archive)).unwrap();
        let scanned = engine.scan_blocking(root.id, &Quiet::new()).unwrap();
        engine
            .follow_up_blocking(&scanned.follow_up, &Quiet::new())
            .unwrap();
        Self {
            engine,
            root,
            data_dir: data.tidy(),
            media,
        }
    }

    fn paths(&self) -> HashMap<String, i64> {
        let page = block_on(self.engine.list_files(FileQuery {
            filter: FileFilter::root(Some(self.root.id)),
            sort: FileSortColumn::Path,
            descending: false,
            offset: 0,
            limit: 1000,
        }))
        .unwrap();
        page.rows
            .into_iter()
            .map(|row| (row.rel_path, row.id))
            .collect()
    }

    fn id_of(&self, rel_path: &str) -> i64 {
        *self
            .paths()
            .get(rel_path)
            .unwrap_or_else(|| panic!("{rel_path} is not in the catalog"))
    }

    /// A recorded request with this catalog's ids and root in place of paths.
    fn request(&self, recorded: &Value) -> PlanRequest {
        let paths = self.paths();
        let id = |value: &Value| {
            let path = value.as_str().expect("a path");
            json!(
                paths
                    .get(path)
                    .unwrap_or_else(|| panic!("{path} is not in the catalog"))
            )
        };
        fn walk(
            value: &Value,
            root: RootId,
            root_path: &str,
            id: &dyn Fn(&Value) -> Value,
        ) -> Value {
            match value {
                Value::Array(items) => {
                    Value::Array(items.iter().map(|v| walk(v, root, root_path, id)).collect())
                }
                Value::Object(object) => Value::Object(
                    object
                        .iter()
                        .map(|(key, entry)| {
                            let mapped = match (key.as_str(), entry) {
                                ("fileIds" | "keep" | "remove", Value::Array(items)) => {
                                    Value::Array(items.iter().map(id).collect())
                                }
                                ("fileId", entry) => id(entry),
                                ("rootId", _) => json!(root),
                                ("targetDir", Value::String(folder)) => json!(
                                    oriel_core_tidy::catalog::to_absolute_path(
                                        root_path,
                                        folder.strip_prefix("<root>/").unwrap_or(folder),
                                    )
                                    .to_string_lossy()
                                ),
                                _ => walk(entry, root, root_path, id),
                            };
                            (key.clone(), mapped)
                        })
                        .collect(),
                ),
                other => other.clone(),
            }
        }
        serde_json::from_value(walk(recorded, self.root.id, &self.root.path, &id))
            .expect("a plan request")
    }

    fn follow_up(&self, follow_up: &FollowUp) {
        self.engine
            .follow_up_blocking(follow_up, &Quiet::new())
            .unwrap();
    }

    fn summary(plan: &oriel_core_tidy::contract::PlanSummary) -> Value {
        let mut value = serde_json::to_value(plan).unwrap();
        value.as_object_mut().unwrap().remove("createdAt");
        value
    }

    /// Makes one recorded decision; returns its result in glazier-core's report form.
    pub fn decide(&self, decision: &Value) -> Value {
        let quiet = Quiet::new();
        match decision["do"].as_str().unwrap() {
            "perform" => {
                let request = self.request(&decision["request"]);
                let performed = self.engine.perform_blocking(request, &quiet).unwrap();
                self.follow_up(&performed.applied.follow_up);
                let mut preview = serde_json::to_value(&performed.preview).unwrap();
                preview.as_object_mut().unwrap().remove("planId");
                json!({ "preview": preview, "plan": Self::summary(&performed.applied.plan) })
            }
            "undo" => {
                // In a later second than the change, as glazier-core's runner does: holding's
                // batch folders are named by the second, which the report leaves out.
                let since = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap();
                std::thread::sleep(std::time::Duration::from_millis(
                    1005 - u64::from(since.subsec_millis()),
                ));
                let plans: Vec<i64> = decision["plans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_i64().unwrap())
                    .collect();
                let undone = self.engine.undo_plans_blocking(&plans, &quiet).unwrap();
                self.follow_up(&undone.follow_up);
                let last = undone.plans.len().saturating_sub(1);
                Value::Array(
                    undone
                        .plans
                        .iter()
                        .enumerate()
                        .map(|(index, plan)| {
                            let state = if index == last && !undone.complete {
                                "failed"
                            } else {
                                "done"
                            };
                            json!({ "job": state, "plan": Self::summary(plan) })
                        })
                        .collect(),
                )
            }
            "tidy-up" => {
                let categories: Vec<OptimizeCategory> =
                    serde_json::from_value(decision["categories"].clone()).unwrap();
                let tidied = self
                    .engine
                    .tidy_up_blocking(self.root.id, &categories, &quiet)
                    .unwrap();
                self.follow_up(&tidied.follow_up);
                json!({
                    "plans": tidied.plans.iter().map(Self::summary).collect::<Vec<_>>(),
                    "notes": tidied.notes,
                })
            }
            "dismiss" => {
                let ids = decision["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|file| self.id_of(file.as_str().unwrap()))
                    .collect();
                block_on(self.engine.dismiss_duplicate_set(ids)).unwrap();
                Value::Null
            }
            "spot-variants" => {
                let mut settings = block_on(self.engine.settings()).unwrap();
                settings.spot_variants = true;
                let update = block_on(self.engine.update_settings(settings)).unwrap();
                if update.analyze {
                    self.engine.analyze_blocking(self.root.id, &quiet).unwrap();
                }
                Value::Null
            }
            "restore" => {
                let listing = block_on(self.engine.list_holding(HoldingRequest {
                    root_id: self.root.id,
                    offset: 0,
                    limit: 500,
                }))
                .unwrap();
                let wanted: Vec<String> = decision["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|file| {
                        oriel_core_tidy::catalog::to_absolute_path(
                            &self.root.path,
                            file.as_str().unwrap(),
                        )
                        .to_string_lossy()
                        .into_owned()
                    })
                    .collect();
                let ids = listing
                    .items
                    .iter()
                    .filter(|item| wanted.contains(&item.original_path))
                    .map(|item| item.id)
                    .collect();
                let restored = block_on(self.engine.restore_holding(ids)).unwrap();
                self.follow_up(&FollowUp {
                    rescan: restored.rescan.clone(),
                    analyze: Vec::new(),
                });
                json!({ "restored": restored.restored, "failed": restored.failed })
            }
            "estimate" => {
                let category: OptimizeCategory =
                    serde_json::from_value(decision["category"].clone()).unwrap();
                serde_json::to_value(
                    block_on(self.engine.estimate_optimize(self.root.id, category)).unwrap(),
                )
                .unwrap()
            }
            "mark-emptied" => {
                let batches = block_on(self.engine.holding_batches(self.root.id)).unwrap();
                let emptied =
                    block_on(self.engine.mark_holding_emptied(self.root.id, batches)).unwrap();
                json!({ "emptied": emptied })
            }
            other => panic!("Unknown decision {other}"),
        }
    }

    /// What the archive, holding and the journal hold now, as glazier-core's `changeState`
    /// writes it.
    pub fn state(&self) -> Value {
        let root_id = self.root.id;
        let holding: Vec<Value> = block_on(self.engine.catalog().call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT original_rel, hold_rel, size, reason, state, plan_id FROM holding
              WHERE root_id = ?1 ORDER BY original_rel, hold_rel, id",
            )?;
            let rows = statement.query_map([root_id], |row| {
                Ok(json!({
                    "originalRel": row.get::<_, String>(0)?,
                    "holdRel": batchless(&row.get::<_, String>(1)?),
                    "size": row.get::<_, i64>(2)?,
                    "reason": row.get::<_, String>(3)?,
                    "state": row.get::<_, String>(4)?,
                    "planId": row.get::<_, Option<i64>>(5)?,
                }))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }))
        .unwrap();

        let mut held = Vec::new();
        let holding_folder = self.data_dir.join("holding");
        let mut folders: Vec<_> = fs::read_dir(&holding_folder)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.path())
                    .collect()
            })
            .unwrap_or_default();
        folders.sort();
        for folder in folders {
            let tree = self.tree(&folder);
            for mut file in tree["files"].as_array().unwrap().clone() {
                let path = batchless(file["path"].as_str().unwrap());
                file["path"] = json!(path);
                held.push(file);
            }
        }

        let mut overview =
            serde_json::to_value(block_on(self.engine.overview(root_id)).unwrap()).unwrap();
        overview.as_object_mut().unwrap().remove("lastScanAt");

        json!({
            "archive": self.tree(Path::new(&self.root.path)),
            "holding": holding,
            "held": held,
            "plans": self.journal(),
            "overview": overview,
        })
    }

    fn journal(&self) -> Vec<Value> {
        let mut plans = block_on(self.engine.list_plans(PlanListRequest {
            root_id: Some(self.root.id),
            offset: 0,
            limit: 500,
        }))
        .unwrap();
        plans.sort_by_key(|plan| plan.id);
        plans
            .iter()
            .map(|plan| {
                let page = block_on(self.engine.plan_steps(PlanStepsRequest {
                    plan_id: plan.id,
                    offset: 0,
                    limit: 500,
                }))
                .unwrap();
                let mut value = Self::summary(plan);
                value["steps"] = Value::Array(
                    page.steps
                        .iter()
                        .map(|step| {
                            json!({
                                "action": step.action,
                                "from": self.relative(Some(&step.from_path)),
                                "to": self.relative(step.to_path.as_deref()),
                                "status": step.status,
                                "message": step.message,
                                "bytesBefore": step.bytes_before,
                                "bytesAfter": step.bytes_after,
                            })
                        })
                        .collect(),
                );
                value
            })
            .collect()
    }

    fn relative(&self, path: Option<&str>) -> Value {
        let Some(path) = path else {
            return Value::Null;
        };
        match Path::new(path).strip_prefix(&self.root.path) {
            Ok(relative) => json!(
                relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            ),
            Err(_) => json!(format!(
                "<outside>/{}",
                Path::new(path).file_name().unwrap().to_string_lossy()
            )),
        }
    }

    /// Every file and folder under `folder`, in path order, with what each holds.
    fn tree(&self, folder: &Path) -> Value {
        let mut files = Vec::new();
        let mut folders = Vec::new();
        self.walk(folder, "", &mut files, &mut folders);
        files.sort_by(|left: &Value, right: &Value| {
            left["path"].as_str().cmp(&right["path"].as_str())
        });
        folders.sort();
        json!({ "files": files, "folders": folders })
    }

    fn walk(
        &self,
        folder: &Path,
        rel_dir: &str,
        files: &mut Vec<Value>,
        folders: &mut Vec<String>,
    ) {
        let Ok(entries) = fs::read_dir(folder) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel_path = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                folders.push(rel_path.clone());
                self.walk(&entry.path(), &rel_path, files, folders);
            } else if kind.is_file() {
                let metadata = entry.metadata().unwrap();
                let bytes = fs::read(entry.path()).unwrap();
                let mtime = metadata
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap();
                files.push(json!({
                    "path": rel_path,
                    "size": metadata.len(),
                    "mtimeMs": mtime.as_millis() as i64,
                    "sha256": hex(&Sha256::digest(&bytes)),
                    "media": self.media_of(&entry.path()),
                }));
            }
        }
    }

    /// What a re-encoded file is, as glazier-core's report reads it: sharp's metadata for an
    /// AVIF (which names the format `heif`), ffprobe for a video.
    fn media_of(&self, path: &Path) -> Value {
        let extension = path
            .extension()
            .map(|extension| extension.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if extension == "avif" {
            let probe = self.media.vips.as_ref().unwrap().probe(path).unwrap();
            let size = fs::metadata(path).unwrap().len() as i64;
            let sniffed = sniff_file(path, size).unwrap();
            assert_eq!(sniffed.as_str(), "avif", "{} is no AVIF", path.display());
            return json!({ "format": "heif", "width": probe.width, "height": probe.height });
        }
        if ["mp4", "mov", "webm", "mkv", "avi"].contains(&extension.as_str()) {
            let probe = probe_video(self.media.ffprobe.as_deref().unwrap(), path, None).unwrap();
            return json!({
                "width": probe.width,
                "height": probe.height,
                "durationMs": probe.duration_ms,
                "videoCodec": probe.video_codec,
                "audioCodec": probe.audio_codec,
                "audioStreams": probe.audio_streams,
            });
        }
        Value::Null
    }
}

/// A holding path with its batch named by its plan alone, as glazier-core's report writes it.
pub fn batchless(hold_rel: &str) -> String {
    let bytes = hold_rel.as_bytes();
    let stamp = bytes.len() > 18
        && bytes[..18]
            .iter()
            .enumerate()
            .all(|(index, &byte)| match index {
                4 | 7 => byte == b'-',
                10 => byte == b'_',
                17 => byte == b'-',
                _ => byte.is_ascii_digit(),
            });
    if stamp {
        hold_rel[18..].to_owned()
    } else {
        hold_rel.to_owned()
    }
}

/// How the two engines' re-encodes may differ, and why (see the module docs of `tests/changes.rs`).
pub struct Tolerance {
    /// A re-encoded file's size, as a share of glazier-core's.
    pub size_share: f64,
    /// A re-encoded video's length, in milliseconds.
    pub duration_ms: f64,
}

/// The paths a state says Tidy made: the targets of finished or undone conversions, in the
/// archive and in holding ("Undone conversion").
fn made_paths(state: &Value) -> (Vec<String>, Vec<String>) {
    let mut archive = Vec::new();
    for plan in state["plans"].as_array().unwrap() {
        for step in plan["steps"].as_array().unwrap() {
            let action = step["action"].as_str().unwrap();
            let status = step["status"].as_str().unwrap();
            if action.starts_with("convert-")
                && (status == "done" || status == "undone")
                && let Some(to) = step["to"].as_str()
            {
                archive.push(to.to_owned());
            }
        }
    }
    let held = state["holding"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["reason"] == "Undone conversion")
        .map(|row| row["holdRel"].as_str().unwrap().to_owned())
        .collect();
    (archive, held)
}

/// A step's message as both engines would write it: glazier-core's harness converts through its
/// ffmpeg fallback and says so, where Oriel RS's ffmpeg is the only path and says nothing; and a
/// kept original's sizes are the re-encode's, which differ.
fn message(value: &Value) -> Value {
    match value.as_str() {
        Some(text) if text.starts_with("Converted with ffmpeg (") => Value::Null,
        Some(text) if text.starts_with("Kept the original: ") => {
            json!(text.split(" (").next().unwrap())
        }
        _ => value.clone(),
    }
}

struct Comparer<'a> {
    tolerance: &'a Tolerance,
    found: Vec<String>,
}

impl Comparer<'_> {
    fn exact(&mut self, path: &str, expected: &Value, actual: &Value) {
        for difference in super::report::differences(expected, actual) {
            self.found
                .push(format!("{path}{}", difference.trim_start_matches('$')));
        }
    }

    fn near(&mut self, path: &str, expected: &Value, actual: &Value, share: f64) {
        match (expected.as_f64(), actual.as_f64()) {
            (Some(left), Some(right)) => {
                let allowed = left.abs() * share;
                if (left - right).abs() > allowed {
                    self.found.push(format!(
                        "{path}: {left} ≠ {right} (more than {:.0}% apart)",
                        share * 100.0
                    ));
                }
            }
            _ => self.exact(path, expected, actual),
        }
    }

    /// Files compare exactly, except those Tidy made, which compare by what must match.
    fn files(&mut self, path: &str, expected: &Value, actual: &Value, made: &[String]) {
        let (Some(left), Some(right)) = (expected.as_array(), actual.as_array()) else {
            return self.exact(path, expected, actual);
        };
        let names = |files: &[Value]| -> Vec<String> {
            files
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        };
        if names(left) != names(right) {
            self.found.push(format!(
                "{path}: files {:?} ≠ {:?}",
                names(left),
                names(right)
            ));
            return;
        }
        for (expected, actual) in left.iter().zip(right) {
            let name = expected["path"].as_str().unwrap();
            let at = format!("{path}[{name}]");
            if !made.iter().any(|made| made == name) {
                self.exact(&at, expected, actual);
                continue;
            }
            self.exact(
                &format!("{at}.mtimeMs"),
                &expected["mtimeMs"],
                &actual["mtimeMs"],
            );
            self.near(
                &format!("{at}.size"),
                &expected["size"],
                &actual["size"],
                self.tolerance.size_share,
            );
            let (Some(left), Some(right)) =
                (expected["media"].as_object(), actual["media"].as_object())
            else {
                self.exact(&format!("{at}.media"), &expected["media"], &actual["media"]);
                continue;
            };
            for (key, value) in left {
                let other = right.get(key).unwrap_or(&Value::Null);
                if key == "durationMs" {
                    match (value.as_f64(), other.as_f64()) {
                        (Some(a), Some(b)) if (a - b).abs() <= self.tolerance.duration_ms => {}
                        _ => self
                            .found
                            .push(format!("{at}.media.durationMs: {value} ≠ {other}")),
                    }
                } else {
                    self.exact(&format!("{at}.media.{key}"), value, other);
                }
            }
        }
    }

    fn steps(&mut self, path: &str, expected: &Value, actual: &Value) {
        let (Some(left), Some(right)) = (expected.as_array(), actual.as_array()) else {
            return self.exact(path, expected, actual);
        };
        if left.len() != right.len() {
            return self.exact(path, expected, actual);
        }
        for (index, (expected, actual)) in left.iter().zip(right).enumerate() {
            let at = format!("{path}[{index}]");
            let converted = expected["action"]
                .as_str()
                .is_some_and(|action| action.starts_with("convert-"));
            for key in ["action", "from", "to", "status", "bytesBefore"] {
                self.exact(&format!("{at}.{key}"), &expected[key], &actual[key]);
            }
            self.exact(
                &format!("{at}.message"),
                &message(&expected["message"]),
                &message(&actual["message"]),
            );
            if converted {
                self.near(
                    &format!("{at}.bytesAfter"),
                    &expected["bytesAfter"],
                    &actual["bytesAfter"],
                    self.tolerance.size_share,
                );
            } else {
                self.exact(
                    &format!("{at}.bytesAfter"),
                    &expected["bytesAfter"],
                    &actual["bytesAfter"],
                );
            }
        }
    }

    /// A plan summary: exact, but for the bytes re-encodes came out at.
    fn plan(&mut self, path: &str, expected: &Value, actual: &Value) {
        let (Some(left), Some(right)) = (expected.as_object(), actual.as_object()) else {
            return self.exact(path, expected, actual);
        };
        for (key, value) in left {
            let other = right.get(key).unwrap_or(&Value::Null);
            match key.as_str() {
                "steps" if value.is_array() => self.steps(&format!("{path}.steps"), value, other),
                "bytesAfter" => self.near(
                    &format!("{path}.bytesAfter"),
                    value,
                    other,
                    self.tolerance.size_share,
                ),
                _ => self.exact(&format!("{path}.{key}"), value, other),
            }
        }
        for key in right.keys().filter(|key| !left.contains_key(*key)) {
            self.found.push(format!("{path}.{key}: not expected"));
        }
    }

    fn state(&mut self, path: &str, expected: &Value, actual: &Value) {
        let (made_archive, made_held) = made_paths(expected);
        self.files(
            &format!("{path}.archive.files"),
            &expected["archive"]["files"],
            &actual["archive"]["files"],
            &made_archive,
        );
        self.exact(
            &format!("{path}.archive.folders"),
            &expected["archive"]["folders"],
            &actual["archive"]["folders"],
        );
        // Holding's rows: an undone conversion's row holds the re-encode's size.
        let (left, right) = (
            expected["holding"].as_array().unwrap(),
            actual["holding"].as_array().unwrap(),
        );
        if left.len() == right.len() {
            for (index, (expected, actual)) in left.iter().zip(right).enumerate() {
                let at = format!("{path}.holding[{index}]");
                for key in ["originalRel", "holdRel", "reason", "state", "planId"] {
                    self.exact(&format!("{at}.{key}"), &expected[key], &actual[key]);
                }
                if expected["reason"] == "Undone conversion" {
                    self.near(
                        &format!("{at}.size"),
                        &expected["size"],
                        &actual["size"],
                        self.tolerance.size_share,
                    );
                } else {
                    self.exact(&format!("{at}.size"), &expected["size"], &actual["size"]);
                }
            }
        } else {
            self.exact(
                &format!("{path}.holding"),
                &expected["holding"],
                &actual["holding"],
            );
        }
        self.files(
            &format!("{path}.held"),
            &expected["held"],
            &actual["held"],
            &made_held,
        );
        let (left, right) = (
            expected["plans"].as_array().unwrap(),
            actual["plans"].as_array().unwrap(),
        );
        if left.len() == right.len() {
            for (index, (expected, actual)) in left.iter().zip(right).enumerate() {
                self.plan(&format!("{path}.plans[{index}]"), expected, actual);
            }
        } else {
            self.exact(
                &format!("{path}.plans"),
                &expected["plans"],
                &actual["plans"],
            );
        }
        // Overview: exact, but for the bytes re-encodes came out at.
        let mut left = expected["overview"].clone();
        let mut right = actual["overview"].clone();
        for (key, nested) in [
            ("bytes", None),
            ("bytes", Some("shrink")),
            ("estimatedBytes", Some("shrink")),
        ] {
            let (expected, actual) = match nested {
                Some(group) => (left[group][key].take(), right[group][key].take()),
                None => (left[key].take(), right[key].take()),
            };
            let at = match nested {
                Some(group) => format!("{path}.overview.{group}.{key}"),
                None => format!("{path}.overview.{key}"),
            };
            self.near(&at, &expected, &actual, self.tolerance.size_share);
        }
        self.exact(&format!("{path}.overview"), &left, &right);
    }

    fn result(&mut self, path: &str, decision: &str, expected: &Value, actual: &Value) {
        match decision {
            "perform" => {
                self.exact(
                    &format!("{path}.preview"),
                    &expected["preview"],
                    &actual["preview"],
                );
                self.plan(&format!("{path}.plan"), &expected["plan"], &actual["plan"]);
            }
            "undo" => {
                let (left, right) = (expected.as_array().unwrap(), actual.as_array().unwrap());
                if left.len() != right.len() {
                    return self.exact(path, expected, actual);
                }
                for (index, (expected, actual)) in left.iter().zip(right).enumerate() {
                    self.exact(
                        &format!("{path}[{index}].job"),
                        &expected["job"],
                        &actual["job"],
                    );
                    self.plan(
                        &format!("{path}[{index}].plan"),
                        &expected["plan"],
                        &actual["plan"],
                    );
                }
            }
            "tidy-up" => {
                self.exact(
                    &format!("{path}.notes"),
                    &expected["notes"],
                    &actual["notes"],
                );
                let (left, right) = (
                    expected["plans"].as_array().unwrap(),
                    actual["plans"].as_array().unwrap(),
                );
                if left.len() != right.len() {
                    return self.exact(path, expected, actual);
                }
                for (index, (expected, actual)) in left.iter().zip(right).enumerate() {
                    self.plan(&format!("{path}.plans[{index}]"), expected, actual);
                }
            }
            // The samples are the same files; their ratios are the re-encodes'.
            "estimate" => {
                for key in ["category", "sampled"] {
                    self.exact(&format!("{path}.{key}"), &expected[key], &actual[key]);
                }
                for key in ["ratio", "ratioLow", "ratioHigh"] {
                    self.near(
                        &format!("{path}.{key}"),
                        &expected[key],
                        &actual[key],
                        self.tolerance.size_share,
                    );
                }
            }
            _ => self.exact(path, expected, actual),
        }
    }
}

/// Every difference between glazier-core's decision and Rust's, past the tolerances.
pub fn compare_decision(
    path: &str,
    expected: &Value,
    result: &Value,
    state: &Value,
    tolerance: &Tolerance,
) -> Vec<String> {
    let mut comparer = Comparer {
        tolerance,
        found: Vec::new(),
    };
    let decision = expected["decision"]["do"].as_str().unwrap();
    comparer.result(
        &format!("{path}.result"),
        decision,
        &expected["result"],
        result,
    );
    comparer.state(&format!("{path}.state"), &expected["state"], state);
    comparer.found
}

/// A report of one scenario in glazier-core's form, for writing out next to the vectors.
pub fn scenario_report(archive: &str, decisions: Vec<(Value, Value, Value)>) -> Value {
    json!({
        "archive": archive,
        "decisions": decisions.into_iter().map(|(decision, result, state)| {
            let mut entry = Map::new();
            entry.insert("decision".into(), decision);
            entry.insert("result".into(), result);
            entry.insert("state".into(), state);
            Value::Object(entry)
        }).collect::<Vec<_>>(),
    })
}
