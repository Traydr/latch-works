//! Plan, push, prune and the doctor against a small Pane View on a local port
//! (`oriel_core_sync::testing::FakePaneView`), which checks the signed upload as S3 does. These
//! pin what `push-changes.test.ts` and `prune-deleted.test.ts` pin for lockstep-core: the bounded
//! queue, the signed headers, a reviewed plan's deletes applied once, and runs always finalized.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oriel_core_sync::testing::FakePaneView;
use oriel_core_sync::{
    ApiTarget, DoctorOptions, HashMode, LockstepPlan, Observer, PaneViewClient, PlanOptions,
    PruneOptions, PushOptions, RunEvent, cache_root, doctor, hash_cache_path, load_hash_cache,
    plan_sync, prune_deleted, push_changes,
};
use oriel_runtime::{CancelToken, Cancelled, TokioRuntime};

const TOKEN: &str = "test-sync-token";

struct Setup {
    _scratch: tempfile::TempDir,
    source: std::path::PathBuf,
    cache: std::path::PathBuf,
    server: FakePaneView,
    runtime: TokioRuntime,
}

fn setup(files: &[(&str, &[u8])]) -> Setup {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    for (path, bytes) in files {
        let file = source.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, bytes).unwrap();
    }
    fs::create_dir_all(&source).unwrap();
    Setup {
        cache: cache_root(&scratch.path().join("hash-cache")),
        source,
        _scratch: scratch,
        server: FakePaneView::start(TOKEN),
        runtime: TokioRuntime::start("sync-test-http").unwrap(),
    }
}

impl Setup {
    fn client(&self) -> PaneViewClient {
        PaneViewClient::new(ApiTarget {
            url: self.server.url(),
            token: TOKEN.to_owned(),
        })
        .unwrap()
    }

    fn block_on<T: Send + 'static>(&self, future: impl Future<Output = T> + Send + 'static) -> T {
        futures::executor::block_on(self.runtime.spawn(future)).unwrap()
    }

    fn plan(&self, hash_mode: HashMode) -> LockstepPlan {
        let client = self.client();
        let options = PlanOptions {
            source_root: self.source.clone(),
            hash_cache_root: self.cache.clone(),
            hash_mode,
            directory_concurrency: None,
            file_concurrency: None,
        };
        self.block_on(
            async move { plan_sync(options, Some(&client), None, &CancelToken::new()).await },
        )
        .unwrap()
    }

    fn push_options(&self, plan: Option<LockstepPlan>) -> PushOptions {
        PushOptions {
            api: ApiTarget {
                url: self.server.url(),
                token: TOKEN.to_owned(),
            },
            source_root: self.source.clone(),
            hash_cache_root: self.cache.clone(),
            hash_mode: None,
            max_changes: None,
            plan,
            upload_concurrency: None,
        }
    }
}

/// An observer that keeps every event.
fn recorder() -> (Observer, Arc<Mutex<Vec<RunEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let kept = events.clone();
    (
        Arc::new(move |event| kept.lock().unwrap().push(event)),
        events,
    )
}

#[test]
fn a_push_uploads_with_the_signed_headers_and_a_second_plan_keeps_everything() {
    let setup = setup(&[
        ("a.jpg", b"first"),
        ("folder/b.png", b"second file"),
        ("folder/nested/c.mp4", b"a third, longer file"),
    ]);
    let plan = setup.plan(HashMode::None);
    assert_eq!(plan.counts.upload, 3);
    assert_eq!(plan.total_files, 3);

    let client = setup.client();
    let options = setup.push_options(Some(plan));
    let (observer, events) = recorder();
    let result = setup
        .block_on(async move {
            push_changes(options, &client, Some(&observer), &CancelToken::new()).await
        })
        .unwrap();
    let failures: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            RunEvent::ItemFailure { error, .. } => Some(error.clone()),
            _ => None,
        })
        .collect();
    assert_eq!((result.pushed, result.failed), (3, 0), "{failures:?}");

    let library = setup.server.library();
    assert_eq!(
        library.keys().collect::<Vec<_>>(),
        ["a.jpg", "folder/b.png", "folder/nested/c.mp4"]
    );
    // Each PUT carried the length and checksum Pane View signed (plan 026).
    for upload in setup.server.uploads() {
        assert!(upload.contains_key("x-amz-checksum-sha256"));
        assert!(upload.contains_key("x-amz-meta-sha256"));
        assert!(upload.contains_key("content-length"));
        assert!(!upload.contains_key("transfer-encoding"), "{upload:?}");
    }
    let runs = setup.server.runs();
    assert_eq!(runs.len(), 1);
    let outcome = runs[0].outcome.as_ref().unwrap();
    assert_eq!(outcome["status"], "completed");
    assert_eq!(outcome["counts"]["pushed"], 3.0);

    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(
        event,
        RunEvent::ItemsQueued {
            total: 3,
            total_bytes: 36,
            ..
        }
    )));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, RunEvent::ItemSuccess { .. }))
            .count(),
        3
    );

    // The push hashed every file, so the cache knows them and a second plan keeps them all.
    let cached = load_hash_cache(&setup.source, &setup.cache);
    assert_eq!(cached.cache.entries().len(), 3);
    assert!(hash_cache_path(&setup.source, &setup.cache).exists());
    let again = setup.plan(HashMode::RemoteAware);
    assert_eq!((again.counts.keep, again.counts.upload), (3, 0));
}

#[test]
fn the_upload_queue_starts_three_wide_and_is_bounded_as_asked() {
    let files: Vec<(String, Vec<u8>)> = (0..8)
        .map(|index| (format!("file-{index}.jpg"), vec![b'a' + index as u8; 64]))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
        .collect();

    for (width, expected) in [(None, 3), (Some(1), 1), (Some(8), 8)] {
        let setup = setup(&borrowed);
        setup.server.delay_uploads(Duration::from_millis(150));
        let client = setup.client();
        let mut options = setup.push_options(None);
        options.upload_concurrency = width;
        let result = setup
            .block_on(
                async move { push_changes(options, &client, None, &CancelToken::new()).await },
            )
            .unwrap();
        assert_eq!(result.pushed, 8);
        assert_eq!(setup.server.peak_uploads(), expected, "width {width:?}");
    }

    let setup = setup(&borrowed);
    let client = setup.client();
    let mut options = setup.push_options(None);
    options.upload_concurrency = Some(9);
    let refused = setup
        .block_on(async move { push_changes(options, &client, None, &CancelToken::new()).await });
    assert!(refused.unwrap_err().to_string().contains("between 1 and 8"));
}

#[test]
fn an_update_registers_under_the_remote_spelling() {
    let setup = setup(&[("Photos/IMG_1.JPEG", b"new bytes, longer than before")]);
    setup.server.seed("photos/img_1.jpg", b"old bytes");
    let plan = setup.plan(HashMode::None);
    assert_eq!(plan.counts.update, 1);
    let client = setup.client();
    let options = setup.push_options(Some(plan));
    setup
        .block_on(async move { push_changes(options, &client, None, &CancelToken::new()).await })
        .unwrap();
    let library = setup.server.library();
    assert_eq!(library.keys().collect::<Vec<_>>(), ["photos/img_1.jpg"]);
    assert_eq!(library["photos/img_1.jpg"].size, 29);
}

#[test]
fn a_file_changed_since_the_plan_fails_its_item_and_the_run() {
    let setup = setup(&[("a.jpg", b"one"), ("b.jpg", b"two")]);
    let plan = setup.plan(HashMode::None);
    fs::write(setup.source.join("b.jpg"), b"two, and then some").unwrap();
    let client = setup.client();
    let options = setup.push_options(Some(plan));
    let (observer, events) = recorder();
    let result = setup
        .block_on(async move {
            push_changes(options, &client, Some(&observer), &CancelToken::new()).await
        })
        .unwrap();
    assert_eq!((result.pushed, result.failed), (1, 1));
    let failure = events
        .lock()
        .unwrap()
        .iter()
        .find_map(|event| match event {
            RunEvent::ItemFailure { path, error, .. } => Some((path.clone(), error.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(failure.0, "b.jpg");
    assert!(
        failure.1.contains("Local file changed after planning"),
        "{}",
        failure.1
    );
    assert_eq!(
        setup.server.runs()[0].outcome.as_ref().unwrap()["status"],
        "failed"
    );
}

#[test]
fn a_cancelled_push_is_finalized_as_cancelled() {
    let files: Vec<(String, Vec<u8>)> = (0..6)
        .map(|index| (format!("{index}.jpg"), vec![b'x'; 32 + index]))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
        .collect();
    let setup = setup(&borrowed);
    setup.server.delay_uploads(Duration::from_millis(300));
    let client = setup.client();
    let options = setup.push_options(None);
    let cancel = CancelToken::new();
    let cancel_later = cancel.clone();
    let (observer, events) = recorder();
    let watcher = events.clone();
    std::thread::spawn(move || {
        // Cancel once the first upload has started.
        while !watcher
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, RunEvent::ItemStart { .. }))
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        cancel_later.cancel();
    });
    let error = setup
        .block_on(async move { push_changes(options, &client, Some(&observer), &cancel).await })
        .unwrap_err();
    assert!(error.is::<Cancelled>(), "{error:#}");
    let runs = setup.server.runs();
    let outcome = runs[0].outcome.as_ref().unwrap();
    assert_eq!(outcome["status"], "cancelled");
    assert_eq!(outcome["error"], "Run cancelled by user");
    assert!(setup.server.library().len() < 6);
}

#[test]
fn prune_applies_the_reviewed_deletes_once_and_skips_a_file_that_came_back() {
    let setup = setup(&[("keep.jpg", b"kept")]);
    setup.server.seed("keep.jpg", b"kept");
    setup.server.seed("gone/a.jpg", b"a");
    setup.server.seed("gone/b.jpg", b"b");
    setup.server.seed("Returns.JPEG", b"r");
    let plan = setup.plan(HashMode::None);
    assert_eq!((plan.counts.keep, plan.counts.delete), (1, 3));

    // After the review, one planned delete's file comes back under another spelling.
    fs::write(setup.source.join("returns.jpg"), b"r").unwrap();

    let client = setup.client();
    let options = PruneOptions {
        api: client.target().clone(),
        max_changes: None,
        plan,
    };
    let (observer, events) = recorder();
    let result = setup
        .block_on(async move {
            prune_deleted(options, &client, Some(&observer), &CancelToken::new()).await
        })
        .unwrap();
    assert_eq!((result.pruned, result.skipped, result.failed), (2, 1, 0));
    assert_eq!(
        setup.server.library().keys().collect::<Vec<_>>(),
        ["Returns.JPEG", "keep.jpg"]
    );
    let skipped = events
        .lock()
        .unwrap()
        .iter()
        .find_map(|event| match event {
            RunEvent::ItemSkipped { path, reason, .. } => Some((path.clone(), reason.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(skipped.0, "Returns.JPEG");
    assert_eq!(skipped.1, "the file is back in the source folder");
    let outcome = setup.server.runs()[0].outcome.clone().unwrap();
    assert_eq!(outcome["status"], "completed");
    assert_eq!(outcome["counts"]["pushed"], 2.0);
}

#[test]
fn an_overloaded_store_takes_upload_slots_away() {
    let files: Vec<(String, Vec<u8>)> = (0..6)
        .map(|index| (format!("file-{index}.jpg"), vec![b'a' + index as u8; 64]))
        .collect();
    let borrowed: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(path, bytes)| (path.as_str(), bytes.as_slice()))
        .collect();
    let setup = setup(&borrowed);
    setup.server.delay_uploads(Duration::from_millis(50));
    setup.server.fail_uploads(503);
    let client = setup.client();
    let options = setup.push_options(None);
    let result = setup
        .block_on(async move { push_changes(options, &client, None, &CancelToken::new()).await })
        .unwrap();
    assert_eq!((result.pushed, result.failed), (0, 6));
    // Each 503 gives a slot back, down to one at a time.
    let widths: Vec<usize> = result.upload_widths.iter().map(|&(_, w)| w).collect();
    assert_eq!(widths, [3, 2, 1]);
    assert_eq!(setup.server.peak_uploads(), 3);
}

#[test]
fn prune_sends_six_deletes_at_once() {
    let setup = setup(&[("keep.jpg", b"kept")]);
    for index in 0..14 {
        setup
            .server
            .seed(&format!("gone/{index}.jpg"), format!("{index}").as_bytes());
    }
    setup.server.delay_deletes(Duration::from_millis(100));
    let plan = setup.plan(HashMode::None);
    let client = setup.client();
    let options = PruneOptions {
        api: client.target().clone(),
        max_changes: None,
        plan,
    };
    let (observer, events) = recorder();
    let result = setup
        .block_on(async move {
            prune_deleted(options, &client, Some(&observer), &CancelToken::new()).await
        })
        .unwrap();
    assert_eq!((result.pruned, result.skipped, result.failed), (14, 0, 0));
    assert_eq!(setup.server.peak_deletes(), 6);
    assert!(setup.server.library().is_empty());
    // Every delete still reports its start and its end, numbered in plan order.
    let events = events.lock().unwrap();
    let mut ended: Vec<usize> = events
        .iter()
        .filter_map(|event| match event {
            RunEvent::ItemSuccess { current, .. } => Some(*current),
            _ => None,
        })
        .collect();
    ended.sort_unstable();
    assert_eq!(ended, (1..=14).collect::<Vec<_>>());
    assert!(matches!(events.last(), Some(RunEvent::Complete(_))));
}

#[test]
fn prune_refuses_a_source_folder_that_is_gone() {
    let setup = setup(&[("keep.jpg", b"kept")]);
    setup.server.seed("old.jpg", b"o");
    let plan = setup.plan(HashMode::None);
    fs::remove_dir_all(&setup.source).unwrap();
    let client = setup.client();
    let options = PruneOptions {
        api: client.target().clone(),
        max_changes: None,
        plan,
    };
    let error = setup
        .block_on(async move { prune_deleted(options, &client, None, &CancelToken::new()).await })
        .unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Source folder is not available"),
        "{error}"
    );
    assert!(setup.server.library().contains_key("old.jpg"));
    assert!(
        setup.server.runs().is_empty(),
        "no run starts without the folder"
    );
}

#[test]
fn the_doctor_checks_the_snapshot_with_the_token() {
    let setup = setup(&[]);
    setup.server.seed("a.jpg", b"a");
    let check = |token: &str| {
        let options = DoctorOptions {
            source_root: Some(setup.source.to_string_lossy().into_owned()),
            api_url: Some(setup.server.url()),
            api_token: Some(token.to_owned()),
        };
        setup.block_on(async move { doctor(options, None, &CancelToken::new()).await })
    };
    let passed = check(TOKEN);
    assert!(passed.ok);
    let snapshot = passed.checks.last().unwrap();
    assert_eq!(snapshot.label, "API snapshot");
    assert_eq!(snapshot.detail.as_deref(), Some("1 remote entries"));

    let refused = check("wrong");
    assert!(!refused.ok);
    let detail = refused.checks.last().unwrap().detail.clone().unwrap();
    assert!(
        detail.starts_with("/api/sync/snapshot failed with 401"),
        "{detail}"
    );
}

#[test]
fn a_plan_fails_when_pane_view_cannot_be_reached() {
    let setup = setup(&[("a.jpg", b"a")]);
    let client = PaneViewClient::new(ApiTarget {
        url: "http://127.0.0.1:9".to_owned(),
        token: TOKEN.to_owned(),
    })
    .unwrap();
    let options = PlanOptions {
        source_root: setup.source.clone(),
        hash_cache_root: setup.cache.clone(),
        hash_mode: HashMode::None,
        directory_concurrency: None,
        file_concurrency: None,
    };
    let error = setup
        .block_on(async move { plan_sync(options, Some(&client), None, &CancelToken::new()).await })
        .unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Could not reach Pane View at http://127.0.0.1:9"),
        "{error}"
    );
}
