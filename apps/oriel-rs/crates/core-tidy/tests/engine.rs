//! The engine as the Tidy UI drives it: a scan runs as an `oriel-runtime` job whose progress
//! names its phases, a stopped scan stops, a root outside the sandbox is refused, and the
//! Library's filters answer from the catalog the scan made.

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
    FileFilter, FileFlag, FileKind, FileQuery, FileSortColumn, OptimizeCategory,
};
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_core_tidy::{ScanReport, TidyEngine};
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
