//! The engine as the Tidy UI drives it: a scan runs on a thread of its own and its progress names
//! its phases, a stopped scan stops, a root outside the sandbox is refused in a sandboxed
//! run and taken in the owner's, and the Library's filters answer from the catalog the scan made.
//! A change runs so too, and its Undo puts things back; a file that changed since the scan
//! is left alone; and a change in a root outside the sandbox is refused before anything moves.

use std::fs;
use std::path::{Path, PathBuf};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    FileFilter, FileFlag, FileKind, FileQuery, FileSortColumn, HoldingRequest, OptimizeCategory,
    PlanListRequest, PlanRequest, PlanStatus, PlanStepsRequest, StepStatus,
};
use oriel_core_tidy::{Media, Quiet};
use oriel_test_archive::Built;

use crate::running::Running;
use crate::support;

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

    /// The test archive, built here.
    fn archive(&self) -> PathBuf {
        self.archive_built().0
    }

    /// The test archive, and what this machine could put in it.
    fn archive_built(&self) -> (PathBuf, Built) {
        let archive = self.0.join("archive");
        let built = oriel_test_archive::build_archive(&archive);
        (archive, built)
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

fn all_files(root_id: i64) -> FileQuery {
    FileQuery {
        filter: FileFilter::root(Some(root_id)),
        sort: FileSortColumn::Path,
        descending: false,
        offset: 0,
        limit: 1000,
    }
}

#[test]
fn a_scan_names_its_phases() {
    let scratch = Scratch::new("job");
    let (archive, built) = scratch.archive_built();
    // No libvips or ffmpeg: the walk, sniffing and hashing still run.
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();

    let scan = Running::start(engine.scan(root.id));
    let progress = scan.progress.clone();
    let report = scan.finish().expect("the scan succeeded");
    assert_eq!(report.files, built.files());
    assert_eq!(report.empty_folders, 1);
    let phases = progress.phases();
    assert!(
        phases.iter().any(|phase| phase.starts_with("Walking ")),
        "{phases:?}"
    );
    assert!(
        phases.iter().any(|phase| phase == "Identifying formats"),
        "{phases:?}"
    );

    let overview = block_on(engine.overview(root.id)).unwrap();
    assert_eq!(overview.files as usize, built.files());
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

    let error = engine.scan(root.id).run(&progress).unwrap_err();
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
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside, &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(outside, &link).unwrap();
    assert!(block_on(engine.add_root(&link)).is_err());
    assert!(block_on(engine.roots()).unwrap().is_empty());

    // Roots never nest.
    let archive = scratch.0.join("archive");
    fs::create_dir_all(archive.join("inner")).unwrap();
    block_on(engine.add_root(&archive)).unwrap();
    assert!(block_on(engine.add_root(&archive.join("inner"))).is_err());
}

#[test]
fn the_owners_run_takes_a_root_anywhere_with_electrons_refusals() {
    // The owner's own data root (no ORIEL_DATA_DIR) is not sandboxed (decision 18), so a
    // folder outside the sandbox and the temp folder is a root. Only added, never scanned: it is
    // this crate's source.
    let scratch = Scratch::new("owner");
    let data = DataRoot::under_home(&scratch.0).unwrap();
    assert!(!data.is_sandboxed());
    let engine = block_on(TidyEngine::open_with(
        data.clone(),
        data.tidy().join("catalog.sqlite"),
        Media::default(),
    ))
    .unwrap();
    let outside =
        oriel_runtime::paths::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let root = block_on(engine.add_root(&outside)).unwrap();
    assert_eq!(Path::new(&root.path), outside);

    // Electron Oriel's refusals still hold: roots never nest, either way round, and a missing
    // folder or a file is no root.
    for refused in [
        outside.join("src"),
        outside.parent().unwrap().to_path_buf(),
        outside.join("no-such-folder"),
        outside.join("Cargo.toml"),
    ] {
        assert!(
            block_on(engine.add_root(&refused)).is_err(),
            "{} was added",
            refused.display()
        );
    }
    assert_eq!(block_on(engine.roots()).unwrap().len(), 1);
}

#[test]
fn the_library_filters_the_catalog_a_scan_made() {
    let (Some(media), Some(_)) = (support::media(), oriel_test_archive::media_tools()) else {
        return;
    };
    let scratch = Scratch::new("library");
    let archive = scratch.archive();
    let engine = scratch.engine(media);
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan(root.id).run(&Quiet::new()).unwrap();

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

#[test]
fn a_change_names_its_phases_and_one_undo_puts_it_back() {
    let scratch = Scratch::new("change-job");
    let archive = scratch.archive();
    // Clean up needs no tools: renames, holds and a folder removal.
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan(root.id).run(&Quiet::new()).unwrap();

    let change = Running::start(engine.perform(PlanRequest::Cleanup { root_id: root.id }));
    let progress = change.progress.clone();
    let performed = change.finish().expect("the change succeeded");
    assert_eq!(performed.preview.steps, 3);
    let applied = performed.applied;
    assert_eq!(applied.plan.status, PlanStatus::Applied);
    assert_eq!(applied.plan.title, "Cleaned up 3 items");
    assert_eq!((applied.plan.done, applied.plan.held.files), (3, 1));
    assert!(applied.follow_up.rescan.is_empty());
    assert!(archive.join("photos/cover.avif").is_file());
    assert!(!archive.join("._sunset.png").exists());
    assert!(!archive.join("empty").exists());
    let held = block_on(engine.list_holding(HoldingRequest {
        root_id: root.id,
        offset: 0,
        limit: 50,
    }))
    .unwrap();
    assert_eq!(held.total, 1);
    // Holding is outside the root, in Tidy's data folder.
    assert!(!Path::new(&held.items[0].hold_path).starts_with(&archive));
    let phases = progress.phases();
    for phase in [
        "Cleaning up 3 items",
        "Renaming files",
        "Removing empty folders",
    ] {
        assert!(phases.iter().any(|seen| seen == phase), "{phases:?}");
    }

    let undone = Running::start(engine.undo(vec![applied.plan.id]))
        .finish()
        .unwrap();
    assert!(undone.complete, "{:?}", undone.message);
    assert_eq!(undone.plans[0].status, PlanStatus::Undone);
    assert_eq!(undone.follow_up.rescan, [root.id]);
    drop(undone);
    assert!(archive.join("photos/cover.jpg").is_file());
    assert!(archive.join("._sunset.png").is_file());
    assert!(archive.join("empty").is_dir());
    let history = block_on(engine.list_plans(PlanListRequest {
        root_id: Some(root.id),
        offset: 0,
        limit: 20,
    }))
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
    engine.scan(root.id).run(&Quiet::new()).unwrap();
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&copy_path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    // Windows has no mode bits; the read-only attribute is the change of attributes alone.
    #[cfg(windows)]
    {
        let mut read_only = fs::metadata(&copy_path).unwrap().permissions();
        read_only.set_readonly(true);
        fs::set_permissions(&copy_path, read_only).unwrap();
    }

    let performed = engine
        .perform(PlanRequest::Hold {
            file_ids: vec![forest, copy],
        })
        .run(&Quiet::new())
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
    engine.scan(root.id).run(&Quiet::new()).unwrap();
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
        .perform(PlanRequest::Hold {
            file_ids: vec![junk],
        })
        .run(&Quiet::new())
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

/// Restore, Undo and Empty Holding move only what is in Oriel's own holding: a row that points
/// elsewhere (into Electron Oriel's holding, as its catalog's might) leaves that file where it is,
/// and a row whose file is gone from Oriel's holding says so and empties.
#[test]
fn only_oriels_holding_is_restored_undone_or_emptied() {
    let scratch = Scratch::new("foreign-holding");
    let archive = scratch.archive();
    let engine = scratch.engine(Media::default());
    let root = block_on(engine.add_root(&archive)).unwrap();
    engine.scan(root.id).run(&Quiet::new()).unwrap();
    let junk = file_id(&engine, root.id, "._sunset.png");
    let performed = engine
        .perform(PlanRequest::Hold {
            file_ids: vec![junk],
        })
        .run(&Quiet::new())
        .unwrap();
    let listed = |engine: &TidyEngine| {
        block_on(engine.list_holding(HoldingRequest {
            root_id: root.id,
            offset: 0,
            limit: 10,
        }))
        .unwrap()
    };
    let held = listed(&engine);
    let id = held.items[0].id;
    let own = PathBuf::from(&held.items[0].hold_path);
    let set_place = |hold: &Path, batch: &Path| {
        let (hold, batch) = (
            hold.to_string_lossy().into_owned(),
            batch.to_string_lossy().into_owned(),
        );
        block_on(engine.catalog().call(move |connection| {
            connection.execute(
                "UPDATE holding SET hold_path = ?1, batch_path = ?2",
                [hold, batch],
            )?;
            Ok(())
        }))
        .unwrap();
    };

    let electron_batch = scratch
        .0
        .join("home/.latch-works/glazier/holding/1-archive/2026-10-31_000000-manual");
    let electron = electron_batch.join("._sunset.png");
    fs::create_dir_all(&electron_batch).unwrap();
    fs::write(&electron, b"Electron Oriel's").unwrap();
    set_place(&electron, &electron_batch);
    let restored = engine.restore_holding(vec![id]).run(&Quiet::new()).unwrap();
    assert_eq!(restored.restored, 0);
    assert!(
        restored.failed[0].contains("not in Oriel's holding"),
        "{restored:?}"
    );
    let undone = engine
        .undo(vec![performed.applied.plan.id])
        .run(&Quiet::new())
        .unwrap();
    // The step stays done, with why it did not come back.
    assert_eq!(undone.plans[0].undone, 0, "{undone:?}");
    let emptied = engine.empty_holding(root.id).run(&Quiet::new()).unwrap();
    assert_eq!(emptied.emptied, 0);
    assert_eq!(emptied.failed.len(), 1, "{emptied:?}");
    assert_eq!(fs::read(&electron).unwrap(), b"Electron Oriel's");
    assert!(!archive.join("._sunset.png").exists());

    // Back in Oriel's holding, but gone from there.
    fs::remove_dir_all(own.parent().unwrap()).unwrap();
    set_place(&own, own.parent().unwrap());
    let restored = engine.restore_holding(vec![id]).run(&Quiet::new()).unwrap();
    assert!(
        restored.failed[0].contains("missing from holding"),
        "{restored:?}"
    );
    let emptied = engine.empty_holding(root.id).run(&Quiet::new()).unwrap();
    assert_eq!(
        (emptied.emptied, emptied.failed.len()),
        (1, 0),
        "{emptied:?}"
    );
    assert_eq!(listed(&engine).total, 0);
    assert_eq!(fs::read(&electron).unwrap(), b"Electron Oriel's");
}
