//! `wire.json`, which Pane View's sync routes are also tested against: the client must post the
//! same bodies to the same routes, read the sample snapshot answers the same way, and wait as
//! long.

use std::path::PathBuf;

use oriel_core_domain::{MediaItem, detect_media_type, get_base_name, get_extension};
use serde_json::Value;

use crate::api::{
    CREATE_SYNC_RUN_CANCEL_GRACE, FINALIZE_ATTEMPT_TIMEOUT, FINALIZE_RETRY_DELAYS,
    MAX_MEDIA_FACTS_PER_REQUEST, delete_body, json_body, parse_snapshot, routes, types,
};
use crate::events::RunAction;
use crate::media_facts::{MissingAudioFact, media_facts_requests, videos_missing_audio_facts};
use crate::plan::LockstepPlan;
use crate::push::registration;
use crate::sync_plan::{
    PlanCounts, RemoteEntrySnapshot, SyncPlanAction, SyncPlanItem, create_sync_plan,
};
use crate::sync_run::{Interruption, RunOutcome, create_run_body, outcome_body};

fn wire() -> Value {
    super::read_vectors("wire.json")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string in wire.json")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("a whole number in wire.json")
}

fn body(value: &impl serde::Serialize) -> Value {
    json_body(value).expect("a body serializes")
}

/// The plan the run bodies describe: one item of each action, from `/Volumes/Archive`.
fn plan(counts: &Value) -> LockstepPlan {
    let items = [
        SyncPlanAction::Upload,
        SyncPlanAction::Update,
        SyncPlanAction::Keep,
        SyncPlanAction::Delete,
    ]
    .into_iter()
    .map(|action| SyncPlanItem {
        action,
        local: None,
        remote: None,
        path: format!("{}.jpg", action.as_str()),
    })
    .collect::<Vec<_>>();
    let plan = LockstepPlan {
        counts: PlanCounts::of(&items),
        items,
        skipped_entries: Vec::new(),
        source_root: PathBuf::from("/Volumes/Archive"),
        total_bytes: 0,
        total_files: 3,
    };
    for action in ["upload", "update", "keep", "delete"] {
        assert_eq!(
            number(&counts[action]),
            1,
            "the vectors' plan has one {action}"
        );
    }
    plan
}

#[test]
fn registers_files_as_lockstep_core_does() {
    let wire = wire();
    for case in wire["registrations"].as_array().unwrap() {
        let name = text(&case["name"]);
        let item = &case["item"];
        let path = text(&item["path"]);
        let file_name = get_base_name(path);
        let media = MediaItem {
            id: path.to_owned(),
            path: path.to_owned(),
            parent_path: String::new(),
            extension: get_extension(&file_name),
            media_type: detect_media_type(&file_name),
            name: file_name,
            size: number(&item["size"]),
            mtime_ms: number(&item["mtimeMs"]) as f64,
            sha256: None,
            width: None,
            height: None,
            duration_ms: None,
            page_count: None,
            thumbnail_url: None,
            original_url: None,
        };
        let recorded = &case["completeObject"];
        let (signing, mut recording) = registration(
            &media,
            text(&case["logicalPath"]),
            text(&item["sha256"]),
            media.size,
            case.get("hasAudio")
                .map(|has_audio| has_audio.as_bool().unwrap()),
            text(&recorded["syncRunId"]),
        )
        .unwrap();
        recording.object_key = text(&recorded["objectKey"]).to_owned();
        assert_eq!(body(&signing), case["uploadUrl"], "{name}: upload-url");
        assert_eq!(body(&recording), *recorded, "{name}: complete-object");
    }
    let delete = &wire["delete"];
    assert_eq!(
        body(&delete_body(
            text(&delete["logicalPath"]),
            text(&delete["syncRunId"])
        )),
        *delete
    );
}

#[test]
fn opens_and_finalizes_runs_as_lockstep_core_does() {
    let wire = wire();
    let created = &wire["createRun"];
    let plan = plan(&created["counts"]);
    assert_eq!(body(&create_run_body(&plan)), *created);

    for case in wire["finalize"].as_array().unwrap() {
        let name = text(&case["name"]);
        let action = match text(&case["action"]) {
            "push" => RunAction::Push,
            "prune" => RunAction::Prune,
            other => panic!("{name}: no run action {other}"),
        };
        let outcome = &case["outcome"];
        let interruption = outcome.get("interruption").map(|kind| match text(kind) {
            "cancelled" => Interruption::Cancelled,
            "failed" => Interruption::Failed(anyhow::anyhow!("{}", text(&case["body"]["error"]))),
            other => panic!("{name}: no interruption {other}"),
        });
        let outcome = RunOutcome {
            applied: number(&outcome["applied"]) as usize,
            capped: number(&outcome["capped"]) as usize,
            failed: number(&outcome["failed"]) as usize,
            skipped: number(&outcome["skipped"]) as usize,
            interruption,
        };
        assert_eq!(
            body(&outcome_body(action, &plan, &outcome)),
            case["body"],
            "{name}"
        );
    }
}

#[test]
fn reads_snapshots_as_lockstep_core_does() {
    for case in wire()["snapshots"].as_array().unwrap() {
        let name = text(&case["name"]);
        let read = parse_snapshot(text(&case["body"])).map_err(|error| error.to_string());
        let expected = match case.get("error") {
            Some(error) => Err(text(error).to_owned()),
            None => Ok(case["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(remote_entry)
                .collect()),
        };
        assert_eq!(read, expected, "{name}");
    }
}

/// A snapshot entry as the vectors write one.
fn remote_entry(entry: &Value) -> RemoteEntrySnapshot {
    RemoteEntrySnapshot {
        has_audio: entry
            .get("hasAudio")
            .map(|has_audio| has_audio.as_bool().expect("a boolean in wire.json")),
        path: text(&entry["path"]).to_owned(),
        sha256: entry.get("sha256").map(|sha256| text(sha256).to_owned()),
        size: number(&entry["size"]),
    }
}

#[test]
fn finds_the_videos_missing_audio_facts_as_lockstep_core_does() {
    let vectors = &wire()["mediaFacts"];
    let list = |key: &str| {
        vectors[key]
            .as_array()
            .expect("a list in wire.json")
            .clone()
    };
    let local: Vec<MediaItem> = list("local")
        .iter()
        .map(|item| {
            super::media_item(
                text(&item["path"]),
                number(&item["size"]),
                item.get("sha256").map(text),
            )
        })
        .collect();
    let remote: Vec<RemoteEntrySnapshot> = list("remote").iter().map(remote_entry).collect();
    let missing: Vec<MissingAudioFact> = list("missing")
        .iter()
        .map(|fact| MissingAudioFact {
            path: text(&fact["path"]).to_owned(),
            sha256: text(&fact["sha256"]).to_owned(),
            size: number(&fact["size"]),
        })
        .collect();
    let plan = create_sync_plan(&local, &remote);
    assert_eq!(videos_missing_audio_facts(&plan.items), missing);
}

#[test]
fn batches_media_facts_as_lockstep_core_does() {
    let wire = wire();
    assert_eq!(
        number(&wire["constants"]["maxMediaFactsPerRequest"]),
        MAX_MEDIA_FACTS_PER_REQUEST as u64
    );
    let fact = types::MediaFact {
        has_audio: true,
        sha256: "a".repeat(64),
        size: 1.0,
    };
    let facts = vec![fact; MAX_MEDIA_FACTS_PER_REQUEST * 2 + 1];
    let sizes: Vec<u64> = media_facts_requests(&facts)
        .iter()
        .map(|request| request.facts.len() as u64)
        .collect();
    let expected: Vec<u64> = wire["mediaFacts"]["batchSizes"]
        .as_array()
        .unwrap()
        .iter()
        .map(number)
        .collect();
    assert_eq!(sizes, expected);
}

#[test]
fn waits_as_lockstep_core_does() {
    let constants = &wire()["constants"];
    assert_eq!(
        number(&constants["createRunCancelGraceMs"]),
        CREATE_SYNC_RUN_CANCEL_GRACE.as_millis() as u64
    );
    let retries: Vec<u64> = FINALIZE_RETRY_DELAYS
        .iter()
        .map(|delay| delay.as_millis() as u64)
        .collect();
    let expected: Vec<u64> = constants["finalizeRetryDelaysMs"]
        .as_array()
        .unwrap()
        .iter()
        .map(number)
        .collect();
    assert_eq!(retries, expected);
    assert_eq!(
        number(&constants["finalizeAttemptTimeoutMs"]),
        FINALIZE_ATTEMPT_TIMEOUT.as_millis() as u64
    );
}

#[test]
fn posts_to_lockstep_cores_routes() {
    let routes_json = &wire()["constants"]["routes"];
    for (key, route) in [
        ("snapshot", routes::SNAPSHOT),
        ("runs", routes::RUNS),
        ("uploadUrl", routes::UPLOAD_URL),
        ("completeObject", routes::COMPLETE_OBJECT),
        ("mediaFacts", routes::MEDIA_FACTS),
    ] {
        assert_eq!(text(&routes_json[key]), route, "{key}");
    }
    assert_eq!(
        text(&routes_json["completeRun"]),
        routes::complete_run("{syncRunId}")
    );
}
