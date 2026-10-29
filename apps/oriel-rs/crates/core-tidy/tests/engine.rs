//! The engine as the Tidy UI drives it: a scan runs as an `oriel-runtime` job whose progress
//! names its phases, a stopped scan stops, a root outside the sandbox is refused, and the
//! Library's filters answer from the catalog the scan made. A change runs as a job too, and its
//! Undo puts things back; a file that changed since the scan is left alone; and a change in a
//! root outside the sandbox is refused before anything moves.

#[path = "support/report.rs"]
mod report;

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use futures::executor::block_on;
use gpui_kit::TestAppContext;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    FileFilter, FileFlag, FileKind, FileQuery, FileSortColumn, HoldingRequest, OptimizeCategory,
    PlanListRequest, PlanRequest, PlanStatus, PlanStepsRequest, StepStatus,
};
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_core_tidy::{Applied, ScanReport, TidyEngine, Undone};
use oriel_runtime::JobStatus;

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

/// A scratch folder under the temp folder, which Tidy's sandbox admits, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-engine-{label}-{}-{}",
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
        let manifest: report::Manifest =
            serde_json::from_str(&fs::read_to_string(conformance().join("archive.json")).unwrap())
                .unwrap();
        let archive = self.0.join("archive");
        report::copy_archive(&conformance().join("archive"), &manifest, &archive);
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

fn all_files(root_id: i64) -> FileQuery {
    FileQuery {
        filter: FileFilter::root(Some(root_id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 1000,
    }
}

#[gpui_kit::test]
async fn a_scan_runs_as_a_job_that_names_its_phases(cx: &mut TestAppContext) {
    // The work runs on threads of its own, so the test scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    let scratch = Scratch::new("job");
    let archive = scratch.archive();
    // No libvips or ffmpeg: the walk, sniffing and hashing still run.
    let engine = scratch.engine(Media::default());
    let root = engine.add_root(&archive).await.unwrap();

    let job = cx.update(|cx| engine.start_scan(root.id, cx));
    let phases = Rc::new(RefCell::new(Vec::<String>::new()));
    let seen = phases.clone();
    let _watching = cx.update(|cx| {
        cx.observe(&job, move |job, cx| {
            let phase = job.read(cx).progress().phase().to_string();
            let mut seen = seen.borrow_mut();
            if !phase.is_empty() && seen.last() != Some(&phase) {
                seen.push(phase);
            }
        })
    });
    while cx.read(|cx| job.read(cx).is_running()) {
        cx.background_executor
            .timer(std::time::Duration::from_millis(10))
            .await;
    }

    let report: ScanReport = cx.read(|cx| match job.read(cx).status() {
        JobStatus::Succeeded(report) => report.clone(),
        other => panic!("the scan did not succeed: {other:?}"),
    });
    assert_eq!(report.files, 26);
    assert_eq!(report.empty_folders, 1);
    let phases = phases.borrow().clone();
    assert!(
        phases.iter().any(|phase| phase.starts_with("Walking ")),
        "{phases:?}"
    );
    assert!(
        phases.iter().any(|phase| phase == "Identifying formats"),
        "{phases:?}"
    );

    let overview = engine.overview(root.id).await.unwrap();
    assert_eq!(overview.files, 26);
    assert_eq!(overview.cleanup.junk, 1);
    assert_eq!(overview.cleanup.empty_folders, 1);
    assert!(overview.last_scan_at.is_some());
}

#[test]
fn a_stopped_scan_stops_before_it_records_anything() {
    let scratch = Scratch::new("stopped");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();
    let progress = Quiet::new();
    progress.token().cancel();

    let error = engine.scan_blocking(root.id, &progress).unwrap_err();
    assert!(
        error
            .chain()
            .any(|cause| cause.is::<oriel_runtime::Cancelled>()),
        "{error:#}"
    );
    let page = block_on(engine.list_files(all_files(root.id))).unwrap();
    assert_eq!(page.total, 0);
}

#[test]
fn a_root_outside_the_sandbox_is_refused() {
    let scratch = Scratch::new("sandbox");
    let engine = scratch.engine(Media::default());
    let outside = Path::new(env!("CARGO_MANIFEST_DIR"));
    let refused = block_on(engine.add_root(outside)).unwrap_err();
    assert!(refused.to_string().contains("sandbox"), "{refused:#}");

    // A link inside the temp folder to a folder outside it resolves outside, so it is refused.
    let link = scratch.0.join("link");
    std::os::unix::fs::symlink(outside, &link).unwrap();
    assert!(block_on(engine.add_root(&link)).is_err());
    assert!(block_on(engine.roots()).unwrap().is_empty());

    // Roots never nest.
    let archive = scratch.0.join("archive");
    fs::create_dir_all(archive.join("inner")).unwrap();
    block_on(engine.add_root(&archive)).unwrap();
    assert!(block_on(engine.add_root(archive.join("inner"))).is_err());
}

#[test]
fn the_library_filters_the_catalog_a_scan_made() {
    let media = Media::locate();
    if media.vips.is_none() || media.ffprobe.is_none() {
        eprintln!("skipped: needs libvips and the pinned ffprobe");
        return;
    }
    let scratch = Scratch::new("library");
    let archive = scratch.archive();
    let engine = scratch.engine(media);
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();

    let videos = block_on(engine.list_files(FileQuery {
        filter: FileFilter {
            kinds: vec![FileKind::Video],
            ..FileFilter::root(Some(root.id))
        },
        ..all_files(root.id)
    }))
    .unwrap();
    assert_eq!(videos.total, 10);
    assert!(videos.rows.iter().all(|row| row.kind == FileKind::Video));

    let searched = block_on(engine.list_files(FileQuery {
        filter: FileFilter {
            search: "  sunset ".into(),
            ..FileFilter::root(Some(root.id))
        },
        ..all_files(root.id)
    }))
    .unwrap();
    let names: Vec<&str> = searched
        .rows
        .iter()
        .map(|row| row.rel_path.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "._sunset.png",
            "photos/sunset-small.jpg",
            "photos/sunset.png"
        ]
    );

    let in_folder = block_on(engine.list_files(FileQuery {
        filter: FileFilter {
            dir: Some("pages".into()),
            ..FileFilter::root(Some(root.id))
        },
        ..all_files(root.id)
    }))
    .unwrap();
    assert_eq!(in_folder.total, 5);

    // The convertible flag counts what Overview's Convert row counts.
    let overview = block_on(engine.overview(root.id)).unwrap();
    let convertible: i64 = overview
        .convert
        .categories
        .iter()
        .filter(|category| category.category != OptimizeCategory::RenameMp4)
        .map(|category| category.files)
        .sum();
    let flagged = block_on(engine.list_files(FileQuery {
        filter: FileFilter {
            flags: vec![FileFlag::Convertible],
            ..FileFilter::root(Some(root.id))
        },
        ..all_files(root.id)
    }))
    .unwrap();
    assert_eq!(flagged.total, convertible);

    let facets = block_on(engine.file_facets(FileFilter::root(Some(root.id)))).unwrap();
    let junk = facets
        .flags
        .iter()
        .find(|facet| facet.value == FileFlag::Junk)
        .unwrap();
    assert_eq!(junk.files, 1);
    assert_eq!(
        block_on(engine.list_empty_folders(root.id)).unwrap(),
        ["empty"]
    );
}

/// The record of the file at `rel_path`, failing when the catalog has none.
fn file_id(engine: &TidyEngine, root_id: i64, rel_path: &str) -> i64 {
    block_on(engine.list_files(all_files(root_id)))
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.rel_path == rel_path)
        .unwrap_or_else(|| panic!("{rel_path} is not in the catalog"))
        .id
}

#[gpui_kit::test]
async fn a_change_runs_as_a_job_and_one_undo_puts_it_back(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let scratch = Scratch::new("change-job");
    let archive = scratch.archive();
    // Clean up needs no tools: renames, holds and a folder removal.
    let engine = scratch.engine(Media::default());
    let root = engine.add_root(&archive).await.unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();

    let task = cx.update(|cx| engine.perform(PlanRequest::Cleanup { root_id: root.id }, cx));
    let (preview, job) = task.await.unwrap();
    assert_eq!(preview.steps, 3);
    assert_eq!(
        cx.read(|cx| job.read(cx).name().to_string()),
        "Cleaning up 3 items"
    );
    let phases = Rc::new(RefCell::new(Vec::<String>::new()));
    let seen = phases.clone();
    let _watching = cx.update(|cx| {
        cx.observe(&job, move |job, cx| {
            let phase = job.read(cx).progress().phase().to_string();
            let mut seen = seen.borrow_mut();
            if !phase.is_empty() && seen.last() != Some(&phase) {
                seen.push(phase);
            }
        })
    });
    while cx.read(|cx| job.read(cx).is_running()) {
        cx.background_executor
            .timer(std::time::Duration::from_millis(10))
            .await;
    }
    let applied: Applied = cx.read(|cx| match job.read(cx).status() {
        JobStatus::Succeeded(applied) => applied.clone(),
        other => panic!("the change did not succeed: {other:?}"),
    });
    assert_eq!(applied.plan.status, PlanStatus::Applied);
    assert_eq!(applied.plan.title, "Cleaned up 3 items");
    assert_eq!((applied.plan.done, applied.plan.held.files), (3, 1));
    assert!(applied.follow_up.rescan.is_empty());
    assert!(archive.join("photos/cover.avif").is_file());
    assert!(!archive.join("._sunset.png").exists());
    assert!(!archive.join("empty").exists());
    let held = engine
        .list_holding(HoldingRequest {
            root_id: root.id,
            offset: 0,
            limit: 50,
        })
        .await
        .unwrap();
    assert_eq!(held.total, 1);
    // Holding is outside the root, in Tidy's data folder.
    assert!(!Path::new(&held.items[0].hold_path).starts_with(&archive));
    let phases = phases.borrow().clone();
    for phase in ["Renaming files", "Removing empty folders"] {
        assert!(phases.iter().any(|seen| seen == phase), "{phases:?}");
    }

    let undo = cx.update(|cx| engine.start_undo(applied.plan.id, cx));
    while cx.read(|cx| undo.read(cx).is_running()) {
        cx.background_executor
            .timer(std::time::Duration::from_millis(10))
            .await;
    }
    let undone: Undone = cx.read(|cx| undo.read(cx).value().cloned().unwrap());
    assert!(undone.complete, "{:?}", undone.message);
    assert_eq!(undone.plans[0].status, PlanStatus::Undone);
    assert_eq!(undone.follow_up.rescan, [root.id]);
    assert!(archive.join("photos/cover.jpg").is_file());
    assert!(archive.join("._sunset.png").is_file());
    assert!(archive.join("empty").is_dir());
    let history = engine
        .list_plans(PlanListRequest {
            root_id: Some(root.id),
            offset: 0,
            limit: 20,
        })
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert!(!history[0].can_undo());
}

#[test]
fn a_file_that_changed_since_the_scan_is_left_alone() {
    let scratch = Scratch::new("changed");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    let forest = file_id(&engine, root.id, "photos/forest.png");
    let copy = file_id(&engine, root.id, "photos/forest copy.png");

    // New bytes since the scan: skipped, and the root wants a scan.
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(archive.join("photos/forest.png"))
        .unwrap();
    std::io::Write::write_all(&mut file, b"more").unwrap();
    drop(file);
    // Only the ctime moved, as a sync client tagging a file does: the bytes still hash the
    // same, so the change goes ahead.
    let copy_path = archive.join("photos/forest copy.png");
    let mode = fs::metadata(&copy_path).unwrap().permissions();
    fs::set_permissions(&copy_path, mode).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(&copy_path, fs::Permissions::from_mode(0o600)).unwrap();

    let performed = engine
        .perform_blocking(
            PlanRequest::Hold {
                file_ids: vec![forest, copy],
            },
            &Quiet::new(),
        )
        .unwrap();
    let plan = performed.applied.plan;
    assert_eq!((plan.done, plan.skipped), (1, 1));
    assert_eq!(performed.applied.follow_up.rescan, [root.id]);
    assert!(archive.join("photos/forest.png").is_file());
    assert!(!copy_path.exists());
    let steps = block_on(engine.plan_steps(PlanStepsRequest {
        plan_id: plan.id,
        offset: 0,
        limit: 10,
    }))
    .unwrap();
    let skipped = steps
        .steps
        .iter()
        .find(|step| step.status == StepStatus::Skipped)
        .unwrap();
    assert_eq!(
        skipped.message.as_deref(),
        Some("The file changed since the scan; rescan before changing it.")
    );
}

#[test]
fn a_change_in_a_root_outside_the_sandbox_is_refused() {
    let scratch = Scratch::new("outside");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    let junk = file_id(&engine, root.id, "._sunset.png");

    // A catalog whose root has moved outside the sandbox (an old catalog, or one edited by
    // hand): the executor refuses before it touches anything.
    let outside = Path::new(env!("CARGO_MANIFEST_DIR"))
        .to_string_lossy()
        .into_owned();
    block_on(engine.catalog().call(move |connection| {
        connection.execute("UPDATE roots SET path = ?1", [outside])?;
        Ok(())
    }))
    .unwrap();
    let refused = engine
        .perform_blocking(
            PlanRequest::Hold {
                file_ids: vec![junk],
            },
            &Quiet::new(),
        )
        .unwrap_err();
    assert!(
        format!("{refused:#}").contains("outside Tidy's sandbox"),
        "{refused:#}"
    );
    assert!(archive.join("._sunset.png").is_file());
    let held = block_on(engine.list_holding(HoldingRequest {
        root_id: root.id,
        offset: 0,
        limit: 10,
    }))
    .unwrap();
    assert_eq!(held.total, 0);
}
