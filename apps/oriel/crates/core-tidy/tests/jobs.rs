//! Tidy's jobs as glazier-core's queue schedules them: background analysis waits behind work the
//! owner asked for, steps aside when such work arrives with nothing of its own in flight, and
//! goes on after; a paused job holds its turn and still stops when cancelled; and a root stays
//! while asked-for work on it waits or runs, while its background analysis is stopped for it to
//! go.

use std::fs;
use std::path::PathBuf;
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

    /// The test archive, built here, and how many files it holds.
    fn archive(&self) -> (PathBuf, usize) {
        let archive = self.0.join("archive");
        let built = oriel_test_archive::build_archive(&archive);
        (archive, built.files())
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
    let (archive, files) = scratch.archive();
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

    // Nothing but work behind it waits: what the pages read, and emptying holding, answer.
    assert_eq!(engine.roots().await.unwrap().len(), 1);
    engine.overview(root.id).await.unwrap();
    engine.empty_holding(root.id).await.unwrap();

    let refused = engine.remove_root(root.id).await.unwrap_err();
    assert!(refused.to_string().contains("paused"), "{refused}");
    assert!(engine.check_root_removable(root.id).is_err());

    scan.update(cx, |job, cx| job.resume(cx));
    until(cx, |cx| !scan.read(cx).is_running()).await;
    let report = cx.read(|cx| scan.read(cx).value().cloned());
    assert_eq!(report.expect("the scan finished").files, files);
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
    let (archive, _) = scratch.archive();
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
    // The clips' fingerprints and loudness are the analysis's work after the stills, where it
    // meets the waiting scan; without the pinned ffmpeg there are none, and it finishes first.
    if media.ffmpeg.is_none() {
        eprintln!("skipped: the analysis needs the archive's clips, which need the pinned ffmpeg");
        return;
    }
    let scratch = Scratch::new("step-aside");
    let (archive, _) = scratch.archive();
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

/// A stand-in for ffmpeg that works for a while on its first run of these `calls`, a pattern over
/// its arguments, ticking so its progress shows, then does the real thing.
#[cfg(unix)]
fn a_slow_tool(scratch: &Scratch, real: &std::path::Path, calls: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let shim = scratch.0.join("slow-ffmpeg");
    let (started, ticks) = (scratch.0.join("started"), scratch.0.join("ticks"));
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \"$*\" in {calls})\n  if [ ! -f '{started}' ]; then\n    : > '{started}'\n    i=0\n    while [ $i -lt 25 ]; do\n      sleep 0.1\n      echo x >> '{ticks}'\n      i=$((i+1))\n    done\n  fi;;\nesac\nexec '{real}' \"$@\"\n",
            started = started.display(),
            ticks = ticks.display(),
            real = real.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    shim
}

#[cfg(unix)]
fn ticks(scratch: &Scratch) -> usize {
    fs::read(scratch.0.join("ticks")).map_or(0, |bytes| bytes.len())
}

/// Waits for a piece of asked-for work on a thread of its own, with time for the tool to finish.
#[cfg(unix)]
async fn proceeds<T: Send + 'static>(
    cx: &mut TestAppContext,
    what: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> T {
    let handle = std::thread::spawn(work);
    for _ in 0..6000 {
        if handle.is_finished() {
            return handle.join().unwrap();
        }
        cx.run_until_parked();
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    panic!("{what} still waits behind the paused analysis");
}

/// Pausing background analysis while it is in a tool must not stop what the owner asks for: the
/// tool finishes its file, the analysis steps aside, and a scan, an Undo and a change each go ahead.
/// Resumed, the analysis finishes.
#[cfg(unix)]
#[gpui_kit::test]
async fn paused_analysis_in_a_tool_lets_asked_for_work_go_and_resumes(cx: &mut TestAppContext) {
    use oriel_core_tidy::contract::PlanRequest;

    cx.executor().allow_parking();
    let media = Media::locate();
    let Some(ffmpeg) = media.ffmpeg.clone() else {
        return;
    };
    let scratch = Scratch::new("analysis-in-tool");
    let archive = scratch.0.join("clips-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    let shim = a_slow_tool(&scratch, &ffmpeg, "*");
    let engine = scratch.engine(Media {
        ffmpeg: Some(shim),
        ..media
    });
    let root = engine.add_root(&archive).await.unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    let files = block_on(engine.list_files(FileQuery {
        filter: FileFilter::root(Some(root.id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 100,
    }))
    .unwrap();
    let undoable = engine
        .perform_blocking(
            PlanRequest::Hold {
                file_ids: vec![files.rows[0].id],
            },
            &Quiet::new(),
        )
        .unwrap();

    // The first run from here on is the analysis's own.
    let _ = fs::remove_file(scratch.0.join("started"));
    let _ = fs::remove_file(scratch.0.join("ticks"));
    let analysis = cx.update(|cx| engine.start_background_analysis(root.id, cx));
    until(cx, |_| scratch.0.join("started").exists()).await;
    analysis.update(cx, |job, cx| job.pause(cx));
    let at_pause = ticks(&scratch);

    let (scanning, id) = (engine.clone(), root.id);
    proceeds(cx, "a scan", move || {
        scanning.scan_blocking(id, &Quiet::new())
    })
    .await
    .unwrap();
    assert!(
        ticks(&scratch) > at_pause,
        "the tool ran on to finish its file"
    );
    assert!(cx.read(|cx| analysis.read(cx).is_running()));

    let (undoing, plan) = (engine.clone(), undoable.applied.plan.id);
    let undone = proceeds(cx, "an Undo", move || {
        undoing.undo_plans_blocking(&[plan], &Quiet::new())
    })
    .await
    .unwrap();
    assert!(undone.complete, "{:?}", undone.message);

    let (changing, file) = (engine.clone(), files.rows[1].id);
    let changed = proceeds(cx, "a change", move || {
        changing.perform_blocking(
            PlanRequest::Hold {
                file_ids: vec![file],
            },
            &Quiet::new(),
        )
    })
    .await
    .unwrap();
    assert_eq!(changed.applied.plan.done, 1);

    analysis.update(cx, |job, cx| job.resume(cx));
    for _ in 0..6000 {
        cx.run_until_parked();
        if !cx.read(|cx| analysis.read(cx).is_running()) {
            break;
        }
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    assert!(
        cx.read(|cx| analysis.read(cx).value().is_some()),
        "it finished"
    );
    let pending = block_on(engine.analysis_due(root.id)).unwrap();
    assert!(!pending, "and nothing is left to analyse");
}

/// A change the owner paused stays truly suspended, tool and all, and goes on when resumed.
#[cfg(unix)]
#[gpui_kit::test]
async fn a_paused_change_keeps_its_tool_suspended(cx: &mut TestAppContext) {
    use oriel_core_tidy::contract::{PlanRequest, VideoCodecChoice, VideoQuality};

    cx.executor().allow_parking();
    let media = Media::locate();
    let Some(ffmpeg) = media.ffmpeg.clone() else {
        return;
    };
    let scratch = Scratch::new("change-in-tool");
    let archive = scratch.0.join("clips-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    let shim = a_slow_tool(&scratch, &ffmpeg, "*-c:v*");
    let engine = scratch.engine(Media {
        ffmpeg: Some(shim),
        ..media
    });
    let root = engine.add_root(&archive).await.unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    let files = block_on(engine.list_files(FileQuery {
        filter: FileFilter::root(Some(root.id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 100,
    }))
    .unwrap();
    let busy = files
        .rows
        .iter()
        .find(|row| row.rel_path.ends_with("busy.mp4"))
        .unwrap()
        .id;
    let (_, change) = cx
        .update(|cx| {
            engine.perform(
                PlanRequest::Reencode {
                    file_ids: vec![busy],
                    codec: VideoCodecChoice::Av1,
                    quality: VideoQuality::High,
                },
                cx,
            )
        })
        .await
        .unwrap();
    until(cx, |_| ticks(&scratch) > 0).await;
    change.update(cx, |job, cx| job.pause(cx));
    // A tick written just as the pause arrived lands, then nothing more.
    cx.background_executor
        .timer(Duration::from_millis(400))
        .await;
    let held_at = ticks(&scratch);
    cx.background_executor
        .timer(Duration::from_millis(1200))
        .await;
    assert_eq!(ticks(&scratch), held_at, "the tool held still");
    assert!(cx.read(|cx| change.read(cx).is_running()));

    change.update(cx, |job, cx| job.resume(cx));
    for _ in 0..6000 {
        cx.run_until_parked();
        if !cx.read(|cx| change.read(cx).is_running()) {
            break;
        }
        cx.background_executor
            .timer(Duration::from_millis(10))
            .await;
    }
    assert!(ticks(&scratch) > held_at, "it went on when resumed");
    assert!(
        cx.read(|cx| change.read(cx).value().is_some()),
        "and finished"
    );
}
