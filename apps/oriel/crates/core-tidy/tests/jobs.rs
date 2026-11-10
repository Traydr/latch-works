//! Tidy's work as the engine's queue schedules it: background analysis waits behind work the
//! owner asked for, steps aside when such work arrives with nothing of its own in flight, and
//! goes on after; a paused job holds its turn and still stops when cancelled; and a root stays
//! while asked-for work on it waits or runs, while its background analysis is stopped for it to
//! go.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::AnalysisKind;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{FileFilter, FileQuery, FileSortColumn};
use oriel_core_tidy::{Media, Progress, Quiet};
use oriel_runtime::{CancelToken, PauseToken};

use crate::running::{Running, is_cancelled, until};
use crate::support;

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
            data.tidy_catalog(),
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

#[test]
fn background_analysis_waits_behind_asked_for_work_that_holds_its_root() {
    let scratch = Scratch::new("queue");
    let (archive, files) = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();

    // A paused scan takes its turn and waits at its first checkpoint, holding it.
    let scan = Running::start(engine.scan(root.id));
    scan.progress.pause();
    let analysis = Running::start(engine.analyze(root.id, AnalysisKind::AfterChange));
    analysis.progress.pause();
    until("the analysis to wait", || analysis.progress.is_waiting());
    assert!(analysis.progress.is_background());
    assert!(scan.is_running());
    assert!(
        !scan.progress.is_waiting(),
        "the analysis waits; the scan runs"
    );
    assert!(!scan.progress.is_background());

    // Nothing but work behind it waits: what the pages read answers.
    assert_eq!(block_on(engine.roots()).unwrap().len(), 1);
    block_on(engine.overview(root.id)).unwrap();

    let refused = block_on(engine.remove_root(root.id)).unwrap_err();
    assert!(refused.to_string().contains("paused"), "{refused}");
    assert!(engine.check_root_removable(root.id).is_err());

    scan.progress.resume();
    let report = scan.finish().expect("the scan finished");
    assert_eq!(report.files, files);
    // The analysis has the turn now, paused before it starts.
    until("the analysis to take its turn", || {
        !analysis.progress.is_waiting()
    });
    assert!(analysis.is_running());

    // Background analysis is only worth finishing for a root that stays: removing the root
    // stops it, paused or not.
    let roots = block_on(engine.remove_root(root.id)).unwrap();
    assert!(roots.is_empty());
    let stopped = analysis.finish().unwrap_err();
    assert!(is_cancelled(&stopped), "{stopped:#}");
}

#[test]
fn a_paused_scan_stops_when_cancelled() {
    let scratch = Scratch::new("paused");
    let (archive, _) = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();

    let scan = Running::start(engine.scan(root.id));
    scan.progress.pause();
    until("the walk", || {
        scan.progress
            .phases()
            .iter()
            .any(|phase| phase.starts_with("Walking "))
    });
    // Held at the walk's first checkpoint: nothing recorded, and it stays so.
    std::thread::sleep(Duration::from_millis(50));
    assert!(scan.is_running());
    assert_eq!(file_count(&engine, root.id), 0);

    scan.progress.cancel();
    let progress = scan.progress.clone();
    let stopped = scan.finish().unwrap_err();
    assert!(is_cancelled(&stopped), "{stopped:#}");
    assert!(!progress.is_paused());
    assert_eq!(file_count(&engine, root.id), 0);
}

/// A record of what happened, in order, across threads.
#[derive(Clone, Default)]
struct Log(Arc<(Mutex<Vec<String>>, Condvar)>);

impl Log {
    fn push(&self, line: impl Into<String>) {
        let (lines, pushed) = &*self.0;
        lines.lock().unwrap().push(line.into());
        pushed.notify_all();
    }

    fn lines(&self) -> Vec<String> {
        self.0.0.lock().unwrap().clone()
    }

    /// Waits until `line` is pushed; fails after a minute.
    fn wait_for(&self, line: &str) {
        let (lines, pushed) = &*self.0;
        let (lines, waited) = pushed
            .wait_timeout_while(lines.lock().unwrap(), Duration::from_secs(60), |lines| {
                !lines.iter().any(|seen| seen == line)
            })
            .unwrap();
        assert!(!waited.timed_out(), "never saw {line:?} in {lines:?}");
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
    // The clips' fingerprints and loudness are the analysis's work after the stills, where it
    // meets the waiting scan; without the pinned ffmpeg there are none, and it finishes first.
    let (Some(media), Some(_)) = (support::media(), oriel_test_archive::media_tools()) else {
        return;
    };
    let scratch = Scratch::new("step-aside");
    let (archive, _) = scratch.archive();
    let engine = scratch.engine(media);
    let root = block_on(engine.add_root(&archive)).unwrap();
    let scanned = engine.scan(root.id).run(&Quiet::new()).unwrap();
    assert!(scanned.analysis_due, "the scan queues analysis");

    let log = Log::default();
    std::thread::scope(|scope| {
        let (engine, lines) = (&engine, log.clone());
        let analysis = scope.spawn(move || {
            let progress = Logged {
                hold_until: Some("scan waits"),
                ..Logged::new("analysis", &lines)
            };
            engine
                .analyze(root.id, AnalysisKind::AfterChange)
                .run(&progress)
        });
        log.wait_for("analysis item");
        let lines = log.clone();
        let scan = scope.spawn(move || engine.scan(root.id).run(&Logged::new("scan", &lines)));
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
    assert!(
        !block_on(engine.analysis_due(root.id)).unwrap(),
        "nothing is left to analyse"
    );
}

/// A stand-in for ffmpeg that works for a while on its first run of these `calls`, a pattern over
/// its arguments, ticking so its progress shows (25 ticks), then does the real thing. That run
/// writes its process id to `pid`.
#[cfg(unix)]
fn a_slow_tool(scratch: &Scratch, real: &std::path::Path, calls: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let shim = scratch.0.join("slow-ffmpeg");
    let (started, ticks, pid) = (
        scratch.0.join("started"),
        scratch.0.join("ticks"),
        scratch.0.join("pid"),
    );
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \"$*\" in {calls})\n  if [ ! -f '{started}' ]; then\n    echo $$ > '{pid}'\n    : > '{started}'\n    i=0\n    while [ $i -lt 25 ]; do\n      sleep 0.1\n      echo x >> '{ticks}'\n      i=$((i+1))\n    done\n  fi;;\nesac\nexec '{real}' \"$@\"\n",
            started = started.display(),
            ticks = ticks.display(),
            pid = pid.display(),
            real = real.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    shim
}

#[cfg(unix)]
fn ticks(scratch: &Scratch) -> usize {
    fs::read(scratch.0.join("ticks")).map_or(0, |bytes| bytes.len() / 2)
}

/// Whether the slow tool's process is stopped, as `ps` sees it.
#[cfg(unix)]
fn suspended(scratch: &Scratch) -> bool {
    let Ok(pid) = fs::read_to_string(scratch.0.join("pid")) else {
        return false;
    };
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid.trim()])
        .output()
        .is_ok_and(|output| output.stdout.starts_with(b"T"))
}

/// Waits for a piece of asked-for work on a thread of its own, with time for the tool to finish.
#[cfg(unix)]
fn proceeds<T: Send + 'static>(what: &str, work: impl FnOnce() -> T + Send + 'static) -> T {
    let handle = std::thread::spawn(work);
    until(
        &format!("{what} to go ahead of the paused analysis"),
        || handle.is_finished(),
    );
    handle.join().unwrap()
}

/// Pausing background analysis while it is in a tool must not stop what the owner asks for: the
/// tool finishes its file, the analysis steps aside, and a scan, an Undo and a change each go ahead.
/// Resumed, the analysis finishes.
#[cfg(unix)]
#[test]
fn paused_analysis_in_a_tool_lets_asked_for_work_go_and_resumes() {
    use oriel_core_tidy::contract::PlanRequest;

    let Some(tools) = oriel_test_archive::media_tools() else {
        return;
    };
    let (media, ffmpeg) = (Media::locate(), tools.ffmpeg().to_path_buf());
    let scratch = Scratch::new("analysis-in-tool");
    let archive = scratch.0.join("clips-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    let shim = a_slow_tool(&scratch, &ffmpeg, "*");
    let engine = scratch.engine(Media {
        ffmpeg: Some(shim),
        ..media
    });
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan(root.id).run(&Quiet::new()).unwrap();
    let files = block_on(engine.list_files(FileQuery {
        filter: FileFilter::root(Some(root.id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 100,
    }))
    .unwrap();
    let undoable = engine
        .perform(PlanRequest::Hold {
            file_ids: vec![files.rows[0].id],
        })
        .run(&Quiet::new())
        .unwrap();

    // The first run from here on is the analysis's own.
    let _ = fs::remove_file(scratch.0.join("started"));
    let _ = fs::remove_file(scratch.0.join("ticks"));
    let analysis = Running::start(engine.analyze(root.id, AnalysisKind::AfterChange));
    until("the analysis's tool", || scratch.0.join("started").exists());
    analysis.progress.pause();
    let at_pause = ticks(&scratch);

    let (scanning, id) = (engine.clone(), root.id);
    proceeds("a scan", move || scanning.scan(id).run(&Quiet::new())).unwrap();
    assert!(
        ticks(&scratch) > at_pause,
        "the tool ran on to finish its file"
    );
    assert!(analysis.is_running());

    let (undoing, plan) = (engine.clone(), undoable.applied.plan.id);
    let undone = proceeds("an Undo", move || {
        undoing.undo(vec![plan]).run(&Quiet::new())
    })
    .unwrap();
    assert!(undone.complete, "{:?}", undone.message);

    let (changing, file) = (engine.clone(), files.rows[1].id);
    let changed = proceeds("a change", move || {
        changing
            .perform(PlanRequest::Hold {
                file_ids: vec![file],
            })
            .run(&Quiet::new())
    })
    .unwrap();
    assert_eq!(changed.applied.plan.done, 1);

    analysis.progress.resume();
    analysis.finish().expect("it finished");
    let pending = block_on(engine.analysis_due(root.id)).unwrap();
    assert!(!pending, "and nothing is left to analyse");
}

/// A change the owner paused stays truly suspended, tool and all, and goes on when resumed.
#[cfg(unix)]
#[test]
fn a_paused_change_keeps_its_tool_suspended() {
    use oriel_core_tidy::contract::{PlanRequest, VideoCodecChoice, VideoQuality};

    let Some(tools) = oriel_test_archive::media_tools() else {
        return;
    };
    let (media, ffmpeg) = (Media::locate(), tools.ffmpeg().to_path_buf());
    let scratch = Scratch::new("change-in-tool");
    let archive = scratch.0.join("clips-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    let shim = a_slow_tool(&scratch, &ffmpeg, "*-c:v*");
    let engine = scratch.engine(Media {
        ffmpeg: Some(shim),
        ..media
    });
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan(root.id).run(&Quiet::new()).unwrap();
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
    let change = Running::start(engine.perform(PlanRequest::Reencode {
        file_ids: vec![busy],
        codec: VideoCodecChoice::Av1,
        quality: VideoQuality::High,
    }));
    until("the tool to start", || ticks(&scratch) > 0);
    change.progress.pause();
    until("the tool to be suspended", || suspended(&scratch));
    assert!(change.is_running());

    change.progress.resume();
    change.finish().expect("and finished");
    assert_eq!(ticks(&scratch), 25, "it went on when resumed");
}
