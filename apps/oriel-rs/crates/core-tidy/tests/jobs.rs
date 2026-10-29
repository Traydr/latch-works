//! Tidy's jobs as glazier-core's queue schedules them: background analysis waits behind work the
//! owner asked for, steps aside when such work arrives with nothing of its own in flight, and
//! goes on after; a paused job holds its turn and still stops when cancelled; and a root stays
//! while asked-for work on it waits or runs, while its background analysis is stopped for it to
//! go.

#[path = "support/report.rs"]
mod report;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::executor::block_on;
use gpui_kit::{App, TestAppContext};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{FileFilter, FileQuery, FileSortColumn};
use oriel_core_tidy::passes::fingerprint::pending_fingerprints;
use oriel_core_tidy::passes::{Media, Progress, Quiet};
use oriel_runtime::{CancelToken, JobError, PauseToken};

/// A scratch folder under the temp folder, which Tidy's sandbox admits, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-jobs-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&folder).unwrap();
        Self(folder)
    }

    /// The committed archive, copied with its dates.
    fn archive(&self) -> PathBuf {
        let conformance =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core");
        let manifest: report::Manifest =
            serde_json::from_str(&fs::read_to_string(conformance.join("archive.json")).unwrap())
                .unwrap();
        let archive = self.0.join("archive");
        report::copy_archive(&conformance.join("archive"), &manifest, &archive);
        archive
    }

    fn engine(&self, media: Media) -> TidyEngine {
        let data = DataRoot::at(self.0.join("data")).unwrap();
        block_on(TidyEngine::open_with(
            data.clone(),
            data.tidy().join("catalog.sqlite"),
            media,
        ))
        .unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Waits, a few milliseconds at a time, until `ready` holds; fails after ten seconds.
async fn until(cx: &mut TestAppContext, ready: impl Fn(&App) -> bool) {
    for _ in 0..1000 {
        if cx.read(|cx| ready(cx)) {
            return;
        }
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    panic!("gave up waiting");
}

fn file_count(engine: &TidyEngine, root_id: i64) -> i64 {
    block_on(engine.list_files(FileQuery {
        filter: FileFilter::root(Some(root_id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 1,
    }))
    .unwrap()
    .total
}

#[gpui_kit::test]
async fn background_analysis_waits_behind_asked_for_work_that_holds_its_root(
    cx: &mut TestAppContext,
) {
    // The work runs on threads of its own, so the test scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    let scratch = Scratch::new("queue");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = engine.add_root(&archive).await.unwrap();

    // A paused scan takes its turn and waits at its first checkpoint, holding it.
    let scan = cx.update(|cx| engine.start_scan(root.id, cx));
    scan.update(cx, |job, cx| job.pause(cx));
    let analysis = cx.update(|cx| engine.start_background_analysis(root.id, cx));
    analysis.update(cx, |job, cx| job.pause(cx));
    until(cx, |cx| analysis.read(cx).progress().is_waiting()).await;
    cx.read(|cx| {
        assert!(analysis.read(cx).progress().is_background());
        assert!(scan.read(cx).is_running());
        assert!(scan.read(cx).progress().is_paused());
        assert!(!scan.read(cx).progress().is_background());
    });
    assert_eq!(engine.queued_jobs(), 1, "the analysis waits; the scan runs");

    let refused = engine.remove_root(root.id).await.unwrap_err();
    assert_eq!(
        refused.to_string(),
        "Wait for this root's jobs to finish before removing it."
    );

    scan.update(cx, |job, cx| job.resume(cx));
    until(cx, |cx| !scan.read(cx).is_running()).await;
    let report = cx.read(|cx| scan.read(cx).value().cloned());
    assert_eq!(report.expect("the scan finished").files, 26);
    // The analysis has the turn now, paused before it starts.
    until(cx, |cx| !analysis.read(cx).progress().is_waiting()).await;
    assert!(cx.read(|cx| analysis.read(cx).is_running()));
    assert_eq!(engine.queued_jobs(), 0);

    // Background analysis is only worth finishing for a root that stays: removing the root
    // stops it, paused or not.
    let roots = engine.remove_root(root.id).await.unwrap();
    assert!(roots.is_empty());
    until(cx, |cx| !analysis.read(cx).is_running()).await;
    assert!(cx.read(|cx| {
        analysis
            .read(cx)
            .error()
            .is_some_and(JobError::is_cancelled)
    }));
}

#[gpui_kit::test]
async fn a_paused_scan_stops_when_cancelled(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let scratch = Scratch::new("paused");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = engine.add_root(&archive).await.unwrap();

    let scan = cx.update(|cx| engine.start_scan(root.id, cx));
    scan.update(cx, |job, cx| job.pause(cx));
    until(cx, |cx| {
        scan.read(cx).progress().phase().starts_with("Walking ")
    })
    .await;
    // Held at the walk's first checkpoint: nothing recorded, and it stays so.
    cx.background_executor
        .timer(Duration::from_millis(50))
        .await;
    assert!(cx.read(|cx| scan.read(cx).is_running()));
    assert_eq!(file_count(&engine, root.id), 0);

    scan.update(cx, |job, cx| job.cancel(cx));
    until(cx, |cx| !scan.read(cx).is_running()).await;
    cx.read(|cx| {
        let job = scan.read(cx);
        assert!(job.error().is_some_and(JobError::is_cancelled));
        assert!(!job.progress().is_paused());
    });
    assert_eq!(file_count(&engine, root.id), 0);
}

/// A record of what happened, in order, across threads.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<String>>>);

impl Log {
    fn push(&self, line: impl Into<String>) {
        self.0.lock().unwrap().push(line.into());
    }

    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn has(&self, line: &str) -> bool {
        self.lines().iter().any(|seen| seen == line)
    }

    fn wait_for(&self, line: &str) {
        for _ in 0..2500 {
            if self.has(line) {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("never saw {line:?} in {:?}", self.lines());
    }
}

/// Progress that logs its phases, items and waits. With `hold_until` set, each item it reports
/// done waits for that line first, so the work cannot outrun the test.
struct Logged {
    name: &'static str,
    quiet: Quiet,
    log: Log,
    hold_until: Option<&'static str>,
}

impl Logged {
    fn new(name: &'static str, log: &Log) -> Self {
        Self {
            name,
            quiet: Quiet::new(),
            log: log.clone(),
            hold_until: None,
        }
    }
}

impl Progress for Logged {
    fn phase(&self, label: &str, _: u64) {
        self.log.push(format!("{} phase {label}", self.name));
    }

    fn done(&self, _: u64) {
        self.log.push(format!("{} item", self.name));
        if let Some(line) = self.hold_until {
            self.log.wait_for(line);
        }
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        self.quiet.cancel_token()
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        self.quiet.pause_token()
    }

    fn waiting(&self, waiting: bool) {
        let word = if waiting { "waits" } else { "goes" };
        self.log.push(format!("{} {word}", self.name));
    }
}

#[test]
fn background_analysis_steps_aside_for_a_scan_and_goes_on_after() {
    let media = Media::locate();
    if media.vips.is_none() {
        eprintln!("skipped: fingerprints need libvips");
        return;
    }
    let scratch = Scratch::new("step-aside");
    let archive = scratch.archive();
    let engine = scratch.engine(media);
    let root = block_on(engine.add_root(&archive)).unwrap();
    let scanned = engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    assert_eq!(
        scanned.follow_up.analyze,
        [root.id],
        "the scan queues analysis"
    );

    let log = Log::default();
    std::thread::scope(|scope| {
        let (engine, lines) = (&engine, log.clone());
        let analysis = scope.spawn(move || {
            let progress = Logged {
                hold_until: Some("scan waits"),
                ..Logged::new("analysis", &lines)
            };
            engine.analyze_in_background_blocking(root.id, &progress)
        });
        log.wait_for("analysis item");
        let lines = log.clone();
        let scan = scope.spawn(move || engine.scan_blocking(root.id, &Logged::new("scan", &lines)));
        scan.join().unwrap().unwrap();
        analysis.join().unwrap().unwrap();
    });

    let lines = log.lines();
    let first_scan = lines
        .iter()
        .position(|line| line.starts_with("scan phase"))
        .unwrap();
    let last_scan = lines
        .iter()
        .rposition(|line| line.starts_with("scan "))
        .unwrap();
    assert!(
        lines[first_scan..=last_scan]
            .iter()
            .all(|line| !line.starts_with("analysis item")),
        "nothing of the analysis ran while the scan did: {lines:?}"
    );
    let stepped_aside = lines
        .iter()
        .position(|line| line == "analysis waits")
        .expect("the analysis stepped aside");
    assert!(stepped_aside < last_scan, "{lines:?}");
    assert!(
        lines[last_scan..]
            .iter()
            .any(|line| line == "analysis goes"),
        "the analysis went on after the scan: {lines:?}"
    );
    let pending = block_on(
        engine
            .catalog()
            .call(move |connection| pending_fingerprints(connection, root.id)),
    )
    .unwrap();
    assert_eq!(pending, 0, "every file got its fingerprint");
}
