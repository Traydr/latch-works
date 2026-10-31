//! Every change Tidy offers, made through the engine as the app makes it, then undone, on an
//! archive `oriel-test-archive` builds at test time. The executor is the code that moves the
//! owner's files, so after each change the cases check what it did (what went to holding, what
//! was converted or renamed, and the journal's steps), and after each Undo that the archive is
//! back exactly: the same relative paths, the same bytes (each file's SHA-256) and the same
//! modification times. Holding must agree with its rows throughout, and emptying it must leave
//! nothing held.
//!
//! The archive is glazier-core's differential archive (see `oriel-test-archive`), plus what these
//! cases need beyond it: two stills in no duplicate set, so Convert has stills to convert; a
//! folder holding only Finder's and Explorer's files, which counts as empty; a `.DS_Store` beside
//! media, which the walk leaves out and nothing touches; and two zero-byte files, which are no
//! one's duplicates.
//!
//! Needs libvips and libavif (`cargo run -p xtask -- vendor`). The video cases also need the
//! pinned ffmpeg and ffprobe (`cargo run -p oriel-tools --bin fetch-media-tools`); without them
//! they say so and pass.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::{
    DuplicateScope, DuplicateSet, DuplicateSetRequest, FileFilter, FileFormat, FileId, FileQuery,
    FileSortColumn, HoldingItem, HoldingRequest, OptimizeCategory, PlanId, PlanKind, PlanRequest,
    PlanStatus, PlanStepAction, PlanStepsRequest, PlanSummary, Rename, ResolveGroup, Root,
    SimilarityLevel, StepStatus,
};
use oriel_core_tidy::media::probe_video;
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_core_tidy::scan::sniff_file;
use oriel_core_tidy::{FollowUp, TidyEngine};
use oriel_test_archive::image::codecs::png::CompressionType;
use oriel_test_archive::{original_mtime, save_jpeg, save_png, set_mtime, variant_picture};
use sha2::{Digest as _, Sha256};

/// Every convertible category, as Convert's page and Tidy up offer them.
const CONVERT: [OptimizeCategory; 4] = [
    OptimizeCategory::StillToAvif,
    OptimizeCategory::AnimationToMp4,
    OptimizeCategory::VideoRemux,
    OptimizeCategory::VideoConvert,
];

/// One file as the cases compare it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileState {
    sha256: String,
    size: u64,
    modified: SystemTime,
}

impl FileState {
    fn of(path: &Path) -> FileState {
        let bytes = fs::read(path)
            .unwrap_or_else(|error| panic!("Could not read {}: {error}", path.display()));
        FileState {
            sha256: Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            size: bytes.len() as u64,
            modified: fs::metadata(path).unwrap().modified().unwrap(),
        }
    }

    /// The modification time to the millisecond, which is what the catalog keeps and what a
    /// conversion copies onto its result.
    fn modified_ms(&self) -> u128 {
        self.modified
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    }
}

/// Every file under a folder, by its path relative to it, and every folder.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Tree {
    files: BTreeMap<String, FileState>,
    folders: BTreeSet<String>,
}

impl Tree {
    fn of(folder: &Path) -> Tree {
        let mut tree = Tree {
            files: BTreeMap::new(),
            folders: BTreeSet::new(),
        };
        let mut stack = vec![(folder.to_path_buf(), String::new())];
        while let Some((folder, rel)) = stack.pop() {
            let Ok(entries) = fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.map(Result::unwrap) {
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                if entry.file_type().unwrap().is_dir() {
                    tree.folders.insert(rel.clone());
                    stack.push((entry.path(), rel));
                } else {
                    tree.files.insert(rel, FileState::of(&entry.path()));
                }
            }
        }
        tree
    }

    fn file(&self, rel: &str) -> &FileState {
        self.files
            .get(rel)
            .unwrap_or_else(|| panic!("{rel} is not in the tree"))
    }

    /// The tree with `rel` gone.
    fn without(mut self, rels: &[&str]) -> Tree {
        for rel in rels {
            assert!(self.files.remove(*rel).is_some(), "{rel} was not there");
        }
        self
    }

    /// Every way `self` and `other` differ, one line each.
    fn differences(&self, other: &Tree) -> Vec<String> {
        let mut found = Vec::new();
        for (rel, state) in &self.files {
            match other.files.get(rel) {
                None => found.push(format!("{rel}: gone")),
                Some(now) if now != state => found.push(format!("{rel}: {state:?} became {now:?}")),
                Some(_) => {}
            }
        }
        for rel in other
            .files
            .keys()
            .filter(|rel| !self.files.contains_key(*rel))
        {
            found.push(format!("{rel}: appeared"));
        }
        for folder in self.folders.symmetric_difference(&other.folders) {
            found.push(format!("folder {folder}: only in one"));
        }
        found
    }
}

fn assert_same(expected: &Tree, actual: &Tree, what: &str) {
    let differences = expected.differences(actual);
    assert!(
        differences.is_empty(),
        "{what}:\n{}",
        differences.join("\n")
    );
}

/// One journal step, with its paths relative to the root.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Step {
    action: PlanStepAction,
    from: String,
    to: Option<String>,
    status: StepStatus,
    message: Option<String>,
}

/// A scratch folder under the temp folder, which Tidy's sandbox admits, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Scratch {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-round-trip-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&folder).unwrap();
        Scratch(fs::canonicalize(folder).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// An engine over a freshly built, scanned and analysed archive.
struct Bench {
    engine: TidyEngine,
    root: Root,
    archive: PathBuf,
    holding: PathBuf,
    media: Media,
    videos: bool,
    /// The cover's name once Clean up fixes its extension: an AVIF, or a PNG without libavif.
    cover: &'static str,
    /// The archive as the scan saw it.
    before: Tree,
    _scratch: Scratch,
}

impl Bench {
    /// `None`, with a note, when this machine lacks libvips or libavif.
    fn open(label: &str) -> Option<Bench> {
        let media = Media::locate();
        if media.loaded_vips().is_none() {
            eprintln!("skipped: the round trip needs libvips (cargo run -p xtask -- vendor)");
            return None;
        }
        if let Err(error) = oriel_avif::Libavif::get() {
            eprintln!("skipped: the round trip needs libavif: {error}");
            return None;
        }
        let scratch = Scratch::new(label);
        let archive = scratch.0.join("archive");
        let built = oriel_test_archive::build_archive(&archive);
        add_extras(&archive);
        let bench = Bench::over(scratch, archive, media, built.videos);
        if !bench.videos {
            eprintln!(
                "note: no pinned ffmpeg, so the archive has no clips and the video changes are \
                 skipped (cargo run -p oriel-tools --bin fetch-media-tools)"
            );
        }
        Some(bench)
    }

    /// An engine over `archive`, already built, with it added, scanned and analysed.
    fn over(scratch: Scratch, archive: PathBuf, media: Media, videos: bool) -> Bench {
        let data = DataRoot::at(scratch.0.join("data")).unwrap();
        let engine = block_on(TidyEngine::open_with(
            data.clone(),
            data.tidy().join("catalog.sqlite"),
            media.clone(),
        ))
        .unwrap();
        let root = block_on(engine.add_root(&archive)).unwrap();
        let scanned = engine.scan_blocking(root.id, &Quiet::new()).unwrap();
        engine
            .follow_up_blocking(&scanned.follow_up, &Quiet::new())
            .unwrap();
        let archive = PathBuf::from(&root.path);
        let before = Tree::of(&archive);
        let bench = Bench {
            engine,
            root,
            holding: data.tidy().join("holding"),
            media,
            videos,
            cover: if oriel_avif::Libavif::get().is_ok() {
                "photos/cover.avif"
            } else {
                "photos/cover.png"
            },
            before,
            archive,
            _scratch: scratch,
        };
        bench.assert_holding_agrees();
        assert!(bench.held().is_empty());
        bench
    }

    fn quiet(&self) -> Quiet {
        Quiet::new()
    }

    fn id(&self, rel: &str) -> FileId {
        block_on(self.engine.list_files(FileQuery {
            filter: FileFilter::root(Some(self.root.id)),
            sort: FileSortColumn::Path,
            descending: false,
            offset: 0,
            limit: 1000,
        }))
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.rel_path == rel)
        .unwrap_or_else(|| panic!("{rel} is not in the catalog"))
        .id
    }

    fn follow_up(&self, follow_up: &FollowUp) {
        self.engine
            .follow_up_blocking(follow_up, &self.quiet())
            .unwrap();
    }

    /// Makes a change as the app does, with what it leaves for the engine to do after.
    fn perform(&self, request: PlanRequest) -> PlanSummary {
        let performed = self
            .engine
            .perform_blocking(request, &self.quiet())
            .unwrap();
        self.follow_up(&performed.applied.follow_up);
        let plan = performed.applied.plan;
        assert_eq!(plan.status, PlanStatus::Applied, "{plan:?}");
        assert_eq!(plan.failed, 0, "{plan:?}");
        plan
    }

    /// Undoes plans, newest first, as one Undo does; every one must come back.
    fn undo(&self, plans: &[PlanId]) {
        let undone = self
            .engine
            .undo_plans_blocking(plans, &self.quiet())
            .unwrap();
        assert!(undone.complete, "{:?}", undone.message);
        self.follow_up(&undone.follow_up);
        for plan in &undone.plans {
            assert_eq!(plan.status, PlanStatus::Undone, "{plan:?}");
            assert!(!plan.can_undo());
        }
        for plan in plans {
            for step in self.steps(*plan) {
                assert_ne!(step.status, StepStatus::Done, "{step:?} was not undone");
            }
        }
    }

    /// Undoes plans and checks the archive is as the scan saw it, file for file.
    fn undo_and_check(&self, plans: &[PlanId], what: &str) {
        self.undo(plans);
        assert_same(
            &self.before,
            &Tree::of(&self.archive),
            &format!("the archive after undoing {what}"),
        );
        self.assert_holding_agrees();
    }

    fn rel(&self, path: &str) -> String {
        Path::new(path)
            .strip_prefix(&self.root.path)
            .unwrap_or_else(|_| panic!("{path} is outside the root"))
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    }

    fn steps(&self, plan_id: PlanId) -> Vec<Step> {
        let mut steps: Vec<Step> = block_on(self.engine.plan_steps(PlanStepsRequest {
            plan_id,
            offset: 0,
            limit: 500,
        }))
        .unwrap()
        .steps
        .into_iter()
        .map(|step| Step {
            action: step.action,
            from: self.rel(&step.from_path),
            to: step.to_path.as_deref().map(|to| self.rel(to)),
            status: step.status,
            message: step.message,
        })
        .collect();
        steps.sort();
        steps
    }

    fn held(&self) -> Vec<HoldingItem> {
        block_on(self.engine.list_holding(HoldingRequest {
            root_id: self.root.id,
            offset: 0,
            limit: 500,
        }))
        .unwrap()
        .items
    }

    /// What holding holds, by the original's path relative to the root, with each held file's
    /// state and the reason it was held.
    fn held_by_original(&self) -> BTreeMap<String, (FileState, String)> {
        self.held()
            .into_iter()
            .map(|item| {
                (
                    self.rel(&item.original_path),
                    (FileState::of(Path::new(&item.hold_path)), item.reason),
                )
            })
            .collect()
    }

    /// Holding's rows and holding's folder agree: every held row's file is there, at its size,
    /// inside Tidy's data folder, and every file there is a held row's.
    fn assert_holding_agrees(&self) {
        let held = self.held();
        let mut rows = BTreeSet::new();
        for item in &held {
            let path = PathBuf::from(&item.hold_path);
            assert!(
                path.starts_with(&self.holding),
                "{item:?} is outside holding"
            );
            assert!(
                !path.starts_with(&self.archive),
                "{item:?} is inside the root"
            );
            let size = fs::metadata(&path)
                .unwrap_or_else(|error| panic!("{item:?} is missing: {error}"))
                .len();
            assert_eq!(size as i64, item.size, "{item:?}");
            rows.insert(path);
        }
        let on_disk: BTreeSet<PathBuf> = Tree::of(&self.holding)
            .files
            .into_keys()
            .map(|rel| self.holding.join(rel))
            .collect();
        assert_eq!(rows, on_disk, "holding's rows and its files differ");
    }

    fn duplicate_sets(&self, scope: DuplicateScope) -> Vec<DuplicateSet> {
        block_on(self.engine.duplicate_sets(DuplicateSetRequest {
            root_id: Some(self.root.id),
            offset: 0,
            limit: 100,
            level: SimilarityLevel::Balanced,
            scope,
            dismissed: false,
        }))
        .unwrap()
        .sets
    }

    /// The open set that holds `rel`.
    fn set_with(&self, rel: &str) -> DuplicateSet {
        self.duplicate_sets(DuplicateScope::All)
            .into_iter()
            .find(|set| {
                set.versions
                    .iter()
                    .flat_map(|version| &version.files)
                    .any(|file| file.rel_path == rel)
            })
            .unwrap_or_else(|| panic!("no open set holds {rel}"))
    }

    fn name_of(&self, set: &DuplicateSet, id: FileId) -> String {
        set.versions
            .iter()
            .flat_map(|version| &version.files)
            .find(|file| file.id == id)
            .map(|file| file.rel_path.clone())
            .unwrap()
    }

    /// The set's suggestion as a decision: keep what it keeps, hold the rest.
    fn suggestion(&self, set: &DuplicateSet) -> ResolveGroup {
        let remove = set
            .versions
            .iter()
            .flat_map(|version| &version.files)
            .map(|file| file.id)
            .filter(|id| !set.keep.contains(id))
            .collect();
        ResolveGroup {
            keep: set.keep.clone(),
            remove,
        }
    }

    fn probe(&self, rel: &str) -> oriel_core_tidy::media::VideoProbe {
        probe_video(
            self.media.ffprobe.as_deref().unwrap(),
            &self.archive.join(rel),
            None,
        )
        .unwrap()
    }

    fn format_of(&self, rel: &str) -> FileFormat {
        let path = self.archive.join(rel);
        sniff_file(&path, fs::metadata(&path).unwrap().len() as i64).unwrap()
    }

    /// Checks a conversion's finished steps: each original is in holding with its bytes, each
    /// result is in the archive in `format`, dated as the original was, and nothing else in the
    /// archive changed. Returns the conversions, original to result.
    fn assert_converted(
        &self,
        steps: &[Step],
        format: impl Fn(PlanStepAction) -> FileFormat,
    ) -> BTreeMap<String, String> {
        let now = Tree::of(&self.archive);
        let held = self.held_by_original();
        let mut converted = BTreeMap::new();
        let mut originals = Vec::new();
        let mut results = Vec::new();
        for step in steps.iter().filter(|step| step.status == StepStatus::Done) {
            let to = step.to.clone().expect("a conversion names its result");
            let original = self.before.file(&step.from);
            assert_eq!(&held[&step.from].0, original, "{step:?}: the original held");
            assert_eq!(self.format_of(&to), format(step.action), "{step:?}");
            assert_eq!(
                now.file(&to).modified_ms(),
                original.modified_ms(),
                "{step:?}: the result keeps the original's date"
            );
            converted.insert(step.from.clone(), to.clone());
            originals.push(step.from.clone());
            results.push(to);
        }
        let originals: Vec<&str> = originals.iter().map(String::as_str).collect();
        let results: Vec<&str> = results.iter().map(String::as_str).collect();
        assert_same(
            &self.before.clone().without(&originals),
            &now.without(&results),
            "the archive beside the conversions",
        );
        converted
    }
}

/// What the cases add to the shared archive (see the module docs).
fn add_extras(archive: &Path) {
    fs::create_dir_all(archive.join("extra")).unwrap();
    fs::create_dir_all(archive.join("stale")).unwrap();
    let harbour = archive.join("extra/harbour.png");
    save_png(&variant_picture(11), &harbour, CompressionType::Default);
    let field = archive.join("extra/field.jpg");
    save_jpeg(&variant_picture(12), &field, 85);
    for still in [&harbour, &field] {
        set_mtime(still, original_mtime());
    }
    fs::write(archive.join("stale/.DS_Store"), b"Finder's view settings").unwrap();
    fs::write(archive.join("stale/Thumbs.db"), b"Explorer's thumbnails").unwrap();
    fs::write(archive.join("photos/.DS_Store"), b"Finder's view settings").unwrap();
    fs::write(archive.join("blank.dat"), b"").unwrap();
    fs::write(archive.join("extra/empty.txt"), b"").unwrap();
}

#[test]
fn clean_up_holds_junk_fixes_an_extension_removes_empty_folders_and_undoes() {
    let Some(bench) = Bench::open("cleanup") else {
        return;
    };
    let plan = bench.perform(PlanRequest::Cleanup {
        root_id: bench.root.id,
    });
    assert_eq!(plan.title, "Cleaned up 4 items");
    let done = |action, from: &str, to: Option<&str>| Step {
        action,
        from: from.into(),
        to: to.map(Into::into),
        status: StepStatus::Done,
        message: None,
    };
    let mut expected = vec![
        done(
            PlanStepAction::Rename,
            "photos/cover.jpg",
            Some(bench.cover),
        ),
        done(PlanStepAction::Hold, "._sunset.png", None),
        done(PlanStepAction::RemoveFolder, "empty", None),
        done(PlanStepAction::RemoveFolder, "stale", None),
    ];
    expected.sort();
    assert_eq!(bench.steps(plan.id), expected);

    // The junk, and the files Finder and Explorer left in the folder that held nothing else, are
    // held with their bytes; the `.DS_Store` beside media stays.
    let held = bench.held_by_original();
    let reasons: BTreeMap<&str, &str> = held
        .iter()
        .map(|(rel, (_, reason))| (rel.as_str(), reason.as_str()))
        .collect();
    assert_eq!(
        reasons,
        BTreeMap::from([
            ("._sunset.png", "System junk"),
            (
                "stale/.DS_Store",
                "Left by Finder or Explorer in an empty folder"
            ),
            (
                "stale/Thumbs.db",
                "Left by Finder or Explorer in an empty folder"
            ),
        ])
    );
    for (rel, (state, _)) in &held {
        assert_eq!(state, bench.before.file(rel), "{rel} in holding");
    }
    let mut expected = bench.before.clone().without(&[
        "._sunset.png",
        "stale/.DS_Store",
        "stale/Thumbs.db",
        "photos/cover.jpg",
    ]);
    expected.files.insert(
        bench.cover.into(),
        bench.before.file("photos/cover.jpg").clone(),
    );
    expected.folders.remove("empty");
    expected.folders.remove("stale");
    assert_same(
        &expected,
        &Tree::of(&bench.archive),
        "the archive after Clean up",
    );
    bench.assert_holding_agrees();

    bench.undo_and_check(&[plan.id], "Clean up");
    assert!(bench.held().is_empty());
}

#[test]
fn a_restored_file_stays_put_when_its_change_is_undone() {
    let Some(bench) = Bench::open("restore") else {
        return;
    };
    let plan = bench.perform(PlanRequest::Cleanup {
        root_id: bench.root.id,
    });
    // Holding's Restore puts the junk back on its own.
    let junk = bench
        .held()
        .into_iter()
        .find(|item| item.original_path.ends_with("._sunset.png"))
        .unwrap();
    let restored = block_on(bench.engine.restore_holding(vec![junk.id])).unwrap();
    assert_eq!((restored.restored, restored.failed.len()), (1, 0));
    assert_eq!(
        FileState::of(&bench.archive.join("._sunset.png")),
        *bench.before.file("._sunset.png")
    );
    bench.follow_up(&FollowUp {
        rescan: restored.rescan,
        analyze: Vec::new(),
    });
    bench.assert_holding_agrees();

    // The Undo reverses the rest, and its step for the junk stays done, saying why.
    let undone = bench
        .engine
        .undo_plans_blocking(&[plan.id], &bench.quiet())
        .unwrap();
    bench.follow_up(&undone.follow_up);
    let hold = bench
        .steps(plan.id)
        .into_iter()
        .find(|step| step.action == PlanStepAction::Hold)
        .unwrap();
    assert_eq!(hold.status, StepStatus::Done);
    assert_eq!(
        hold.message.as_deref(),
        Some("Undo failed: That item is no longer in holding.")
    );
    assert_eq!(undone.plans[0].undone, 3);
    assert_same(
        &bench.before,
        &Tree::of(&bench.archive),
        "the archive after the restore and the undo",
    );
    bench.assert_holding_agrees();
}

#[test]
fn a_duplicate_decision_holds_the_copies_and_undoes() {
    let Some(bench) = Bench::open("duplicates") else {
        return;
    };
    // The zero-byte files are nobody's duplicates.
    for set in bench.duplicate_sets(DuplicateScope::All) {
        for file in set.versions.iter().flat_map(|version| &version.files) {
            assert!(file.size > 0, "{} is in {}", file.rel_path, set.key);
        }
    }
    // The copy-style names lose to the original; the video with more pixels is kept over the
    // smaller re-encode and the exact copy.
    let forest = bench.set_with("photos/forest.png");
    assert_eq!(forest.keep, [bench.id("photos/forest.png")]);
    let mut groups = vec![bench.suggestion(&forest)];
    let mut expected_held = vec!["dup/forest (1).png", "photos/forest copy.png"];
    if bench.videos {
        let clips = bench.set_with("clips/with-sound.mp4");
        assert_eq!(clips.keep, [bench.id("clips/with-sound.mp4")]);
        groups.push(bench.suggestion(&clips));
        expected_held.extend(["clips/with-sound-small.mp4", "dup/with-sound-copy.mp4"]);
    }
    let plan = bench.perform(PlanRequest::ResolveDuplicates { groups });
    assert_eq!(plan.held.files, expected_held.len() as i64);

    let held = bench.held_by_original();
    assert_eq!(
        held.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        expected_held.iter().copied().collect()
    );
    for (rel, (state, reason)) in &held {
        assert_eq!(state, bench.before.file(rel), "{rel} in holding");
        assert!(reason.starts_with("Duplicate of "), "{rel}: {reason}");
    }
    assert_same(
        &bench.before.clone().without(&expected_held),
        &Tree::of(&bench.archive),
        "the archive after the decision",
    );
    assert!(
        bench
            .steps(plan.id)
            .iter()
            .all(|step| step.action == PlanStepAction::Hold && step.status == StepStatus::Done)
    );

    bench.undo_and_check(&[plan.id], "the decision");
    // The set is back in review.
    assert_eq!(bench.set_with("photos/forest.png").keep, forest.keep);
}

#[test]
fn keeping_several_versions_remembers_them_until_undone() {
    let Some(bench) = Bench::open("variants") else {
        return;
    };
    let mut settings = block_on(bench.engine.settings()).unwrap();
    settings.spot_variants = true;
    let update = block_on(bench.engine.update_settings(settings)).unwrap();
    if update.analyze {
        bench
            .engine
            .analyze_blocking(bench.root.id, &bench.quiet())
            .unwrap();
    }
    // Spot variants keeps one copy of each of the page's three pictures, from the folder that
    // holds all of them, and holds the other site's copies.
    let page = bench.set_with("pages/fanbox/101_jp.png");
    let kept: BTreeSet<String> = page
        .keep
        .iter()
        .map(|id| bench.name_of(&page, *id))
        .collect();
    assert_eq!(
        kept,
        BTreeSet::from([
            "pages/fanbox/101_clean.png".to_owned(),
            "pages/fanbox/101_en.png".to_owned(),
            "pages/fanbox/101_jp.png".to_owned(),
        ])
    );
    let plan = bench.perform(PlanRequest::ResolveDuplicates {
        groups: vec![bench.suggestion(&page)],
    });
    let copies = ["pages/pixiv/900_p0.jpg", "pages/pixiv/900_p1.png"];
    assert_same(
        &bench.before.clone().without(&copies),
        &Tree::of(&bench.archive),
        "the archive after keeping three versions",
    );
    let dismissed = || {
        block_on(bench.engine.duplicate_sets(DuplicateSetRequest {
            root_id: Some(bench.root.id),
            offset: 0,
            limit: 100,
            level: SimilarityLevel::Balanced,
            scope: DuplicateScope::All,
            dismissed: true,
        }))
        .unwrap()
        .counts
        .dismissed
    };
    assert_eq!(dismissed(), 1, "the versions kept are not duplicates");

    bench.undo_and_check(&[plan.id], "keeping three versions");
    assert_eq!(dismissed(), 0, "the undo forgets that they are not");
}

#[test]
fn convert_makes_avif_and_mp4_keeping_dates_and_undoes() {
    let Some(bench) = Bench::open("convert") else {
        return;
    };
    let plan = bench.perform(PlanRequest::Optimize {
        root_id: bench.root.id,
        categories: CONVERT.to_vec(),
        file_ids: None,
    });
    assert_eq!(plan.kind, PlanKind::Optimize);
    let steps = bench.steps(plan.id);
    let converted = bench.assert_converted(&steps, |action| match action {
        PlanStepAction::ConvertAvif => FileFormat::Avif,
        _ => FileFormat::Mp4,
    });
    let mut expected = BTreeMap::from([
        ("extra/field.jpg", "extra/field.avif"),
        ("extra/harbour.png", "extra/harbour.avif"),
    ]);
    if bench.videos {
        expected.extend([
            ("clips/loop.gif", "clips/loop.mp4"),
            ("clips/odd.webm", "clips/odd.mp4"),
            ("clips/scene.webm", "clips/scene.mp4"),
            ("clips/talk.mov", "clips/talk.mp4"),
        ]);
    }
    for (from, to) in expected {
        assert_eq!(
            converted.get(from).map(String::as_str),
            Some(to),
            "{steps:?}"
        );
    }
    // Files waiting for review in a duplicate set are left as they are.
    for waiting in [
        "photos/sunset.png",
        "photos/forest.png",
        "pages/fanbox/101_jp.png",
    ] {
        assert!(!converted.contains_key(waiting), "{waiting} was converted");
    }
    bench.assert_holding_agrees();

    bench.undo_and_check(&[plan.id], "Convert");
    // The results wait in holding, as an undone conversion's do.
    let held = bench.held_by_original();
    for to in converted.values() {
        assert_eq!(held[to].1, "Undone conversion", "{to}");
    }
}

#[test]
fn removing_a_silent_soundtrack_keeps_the_picture_and_undoes() {
    let Some(bench) = Bench::open("silent") else {
        return;
    };
    if !bench.videos {
        return;
    }
    let overview = block_on(bench.engine.overview(bench.root.id)).unwrap();
    assert_eq!(overview.silent_tracks.files, 1);
    assert_eq!(bench.probe("clips/silent-track.mp4").audio_streams, 1);
    let plan = bench.perform(PlanRequest::StripAudio {
        file_ids: vec![bench.id("clips/silent-track.mp4")],
    });
    let steps = bench.steps(plan.id);
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert_eq!(
        steps[0].to.as_deref(),
        Some("clips/silent-track.mp4"),
        "{steps:?}"
    );
    // The original goes to holding; the result has its picture and length, and no audio.
    let held = bench.held_by_original();
    assert_eq!(
        &held["clips/silent-track.mp4"].0,
        bench.before.file("clips/silent-track.mp4")
    );
    let probe = bench.probe("clips/silent-track.mp4");
    assert_eq!(probe.audio_streams, 0);
    assert_eq!((probe.width, probe.height), (Some(320), Some(240)));
    assert_eq!(probe.video_codec.as_deref(), Some("h264"));
    let now = Tree::of(&bench.archive);
    assert_eq!(
        now.file("clips/silent-track.mp4").modified_ms(),
        bench.before.file("clips/silent-track.mp4").modified_ms()
    );
    assert_same(
        &bench.before.clone().without(&["clips/silent-track.mp4"]),
        &now.without(&["clips/silent-track.mp4"]),
        "the archive beside the stripped video",
    );

    bench.undo_and_check(&[plan.id], "removing the soundtrack");
    assert_eq!(bench.probe("clips/silent-track.mp4").audio_streams, 1);
}

#[test]
fn tidy_up_runs_every_step_but_duplicates_and_one_undo_takes_it_back() {
    let Some(bench) = Bench::open("tidy-up") else {
        return;
    };
    let tidied = bench
        .engine
        .tidy_up_blocking(bench.root.id, &CONVERT, &bench.quiet())
        .unwrap();
    bench.follow_up(&tidied.follow_up);
    assert!(tidied.notes.is_empty(), "{:?}", tidied.notes);
    let kinds: Vec<PlanKind> = tidied.plans.iter().map(|plan| plan.kind).collect();
    let mut expected = vec![PlanKind::Cleanup];
    if bench.videos {
        expected.push(PlanKind::StripAudio);
    }
    expected.push(PlanKind::Optimize);
    assert_eq!(kinds, expected);
    let now = Tree::of(&bench.archive);
    assert!(now.files.contains_key(bench.cover));
    assert!(!now.folders.contains("empty"));
    assert!(!now.files.contains_key("._sunset.png"));
    assert!(now.files.contains_key("extra/harbour.avif"));
    // Duplicates are not a step: the copies wait for review.
    for copy in ["photos/forest copy.png", "dup/forest (1).png"] {
        assert_eq!(now.file(copy), bench.before.file(copy));
    }
    if bench.videos {
        assert!(now.files.contains_key("clips/talk.mp4"));
        assert_eq!(bench.probe("clips/silent-track.mp4").audio_streams, 0);
        assert!(now.files.contains_key("dup/with-sound-copy.mp4"));
    }
    bench.assert_holding_agrees();

    bench.undo_and_check(&tidied.undoable(), "Tidy up");
}

#[test]
fn renames_a_move_and_a_hold_come_back_with_one_undo() {
    let Some(bench) = Bench::open("library") else {
        return;
    };
    let rename = bench.perform(PlanRequest::Rename {
        renames: vec![Rename {
            file_id: bench.id("photos/sunset-small.jpg"),
            name: "sunset-thumb.jpg".into(),
        }],
    });
    let moved_to = bench.archive.join("moved");
    let moved = bench.perform(PlanRequest::Move {
        file_ids: vec![bench.id("notes.txt")],
        target_dir: moved_to.to_string_lossy().into_owned(),
    });
    let hold = bench.perform(PlanRequest::Hold {
        file_ids: vec![bench.id("alt/outfit-a.png")],
    });
    let now = Tree::of(&bench.archive);
    assert_eq!(
        now.file("photos/sunset-thumb.jpg"),
        bench.before.file("photos/sunset-small.jpg")
    );
    assert_eq!(now.file("moved/notes.txt"), bench.before.file("notes.txt"));
    assert_eq!(
        bench.held_by_original()["alt/outfit-a.png"].0,
        *bench.before.file("alt/outfit-a.png")
    );
    let mut expected =
        bench
            .before
            .clone()
            .without(&["photos/sunset-small.jpg", "notes.txt", "alt/outfit-a.png"]);
    expected.files.extend([
        (
            "photos/sunset-thumb.jpg".to_owned(),
            bench.before.file("photos/sunset-small.jpg").clone(),
        ),
        (
            "moved/notes.txt".to_owned(),
            bench.before.file("notes.txt").clone(),
        ),
    ]);
    expected.folders.insert("moved".into());
    assert_same(&expected, &now, "the archive after the three changes");

    // One Undo of all three, newest first. The folder the move made stays, empty, as
    // glazier-core left it; every file is back.
    bench.undo(&[rename.id, moved.id, hold.id]);
    let mut expected = bench.before.clone();
    expected.folders.insert("moved".into());
    assert_same(
        &expected,
        &Tree::of(&bench.archive),
        "the archive after the undo",
    );
    assert_eq!(fs::read_dir(&moved_to).unwrap().count(), 0);
    bench.assert_holding_agrees();
}

#[test]
fn shrink_re_encodes_a_busy_video_to_av1_and_undoes() {
    if oriel_test_archive::ffmpeg().is_none() {
        eprintln!("skipped: Shrink needs the pinned ffmpeg");
        return;
    }
    let media = Media::locate();
    if media.loaded_vips().is_none() {
        eprintln!("skipped: the round trip needs libvips (cargo run -p xtask -- vendor)");
        return;
    }
    let scratch = Scratch::new("shrink");
    let archive = scratch.0.join("shrink-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    let bench = Bench::over(scratch, archive, media, true);
    let plan = bench.perform(PlanRequest::ShrinkVideos {
        root_id: bench.root.id,
        limit_bytes: Some(5e9),
    });
    let steps = bench.steps(plan.id);
    // The noisy clip shrinks; the tiny one comes out larger, so the original is kept; the lean
    // one is not worth offering.
    let busy = steps
        .iter()
        .find(|step| step.from == "clips/busy.mp4")
        .expect("busy.mp4 is shrunk");
    assert_eq!(busy.status, StepStatus::Done, "{busy:?}");
    assert!(
        steps.iter().all(|step| step.from != "clips/lean.mp4"),
        "{steps:?}"
    );
    for step in steps.iter().filter(|step| step.status != StepStatus::Done) {
        assert_eq!(step.status, StepStatus::Skipped, "{step:?}");
        assert!(
            step.message
                .as_deref()
                .is_some_and(|message| message.starts_with("Kept the original")),
            "{step:?}"
        );
    }
    let now = Tree::of(&bench.archive);
    let before = bench.before.file("clips/busy.mp4");
    assert!(now.file("clips/busy.mp4").size < before.size);
    assert_eq!(
        now.file("clips/busy.mp4").modified_ms(),
        before.modified_ms()
    );
    assert_eq!(
        bench.probe("clips/busy.mp4").video_codec.as_deref(),
        Some("av1")
    );
    assert_eq!(&bench.held_by_original()["clips/busy.mp4"].0, before);
    assert_same(
        &bench.before.clone().without(&["clips/busy.mp4"]),
        &now.without(&["clips/busy.mp4"]),
        "the archive beside the shrunk video",
    );

    bench.undo_and_check(&[plan.id], "Shrink");
    assert_eq!(
        bench.probe("clips/busy.mp4").video_codec.as_deref(),
        Some("h264")
    );
}

/// Emptying holding moves its batch folders to the Trash, which on the machine running the tests
/// is the owner's, so the test stands in for the Trash: it takes the batches holding lists away
/// itself and marks them emptied, as Electron Oriel's main process did around the same calls.
#[test]
fn emptying_holding_after_a_change_leaves_nothing_held() {
    let Some(bench) = Bench::open("empty") else {
        return;
    };
    let plan = bench.perform(PlanRequest::Cleanup {
        root_id: bench.root.id,
    });
    let held = bench.held();
    assert_eq!(held.len(), 3);
    let batches = block_on(bench.engine.holding_batches(bench.root.id)).unwrap();
    assert_eq!(batches.len(), 1, "one change, one batch");
    for item in &held {
        assert!(
            Path::new(&item.hold_path).starts_with(&batches[0]),
            "{item:?}"
        );
    }
    for batch in &batches {
        assert!(Path::new(batch).starts_with(&bench.holding));
        fs::remove_dir_all(batch).unwrap();
    }
    let emptied = block_on(bench.engine.mark_holding_emptied(bench.root.id, batches)).unwrap();
    assert_eq!(emptied, 3);
    assert!(bench.held().is_empty());
    assert!(
        block_on(bench.engine.holding_batches(bench.root.id))
            .unwrap()
            .is_empty()
    );
    assert!(Tree::of(&bench.holding).files.is_empty());
    bench.assert_holding_agrees();

    // What was emptied cannot come back; the rest of the change still undoes.
    let undone = bench
        .engine
        .undo_plans_blocking(&[plan.id], &bench.quiet())
        .unwrap();
    bench.follow_up(&undone.follow_up);
    let now = Tree::of(&bench.archive);
    assert!(now.files.contains_key("photos/cover.jpg"));
    assert!(now.folders.contains("empty"));
    assert!(!now.files.contains_key("._sunset.png"));
}
