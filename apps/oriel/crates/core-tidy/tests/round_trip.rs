//! Every change Tidy offers, made through the engine as the app makes it, then undone, on an
//! archive `oriel-test-archive` builds at test time. The executor is the code that moves the
//! owner's files, so after each change the cases check what it did (what went to holding, what
//! was converted or renamed, and the journal's steps), and after each Undo that the archive is
//! back exactly: the same relative paths, the same bytes (each file's SHA-256) and the same
//! modification times. Holding must agree with its rows throughout, and emptying it must leave
//! nothing held.
//!
//! The archive is the differential archive (see `oriel-test-archive`), plus what these
//! cases need beyond it: two stills in no duplicate set, so Convert has stills to convert; a
//! folder holding only Finder's and Explorer's files, which counts as empty; a `.DS_Store` beside
//! media, which the walk leaves out and nothing touches; and two zero-byte files, which are no
//! one's duplicates.
//!
//! Needs libvips and libavif (`cargo run -p xtask -- vendor`), and the video cases the pinned
//! ffmpeg and ffprobe (`cargo run -p xtask -- fetch-media-tools`): see [`support::media`].

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::AnalysisKind;
use oriel_core_tidy::contract::{
    DuplicateKind, DuplicateScope, DuplicateSet, DuplicateSetPage, DuplicateSetRequest, FileFilter,
    FileFormat, FileId, FileQuery, FileSortColumn, HoldingItem, HoldingRequest, KeepReason,
    OptimizeCategory, PlanId, PlanKind, PlanListRequest, PlanRequest, PlanStatus, PlanStepAction,
    PlanStepsRequest, PlanSummary, Rename, ResolveGroup, Root, SimilarityLevel, StepStatus,
    VideoCodecChoice, VideoQuality,
};
use oriel_core_tidy::internals::sniff_file;
use oriel_core_tidy::internals::{
    DETAIL_VERSION, is_variant, look_at_still, look_shows_variant, normalize_detail,
};
use oriel_core_tidy::{AnalysisReport, FollowUp, TidyEngine};
use oriel_core_tidy::{Media, Progress, Quiet};
use oriel_runtime::CancelToken;
use oriel_test_archive::image::codecs::png::CompressionType;
use oriel_test_archive::{original_mtime, save_jpeg, save_png, set_mtime, variant_picture};
use oriel_tools::probe_video;
use oriel_vips::Vips;
use sha2::{Digest as _, Sha256};

use crate::support;

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
    /// The archive as the scan saw it.
    before: Tree,
    _scratch: Scratch,
}

impl Bench {
    /// `None` when this machine lacks libvips or libavif (see [`support::media`]).
    fn open(label: &str) -> Option<Bench> {
        let media = support::media()?;
        let scratch = Scratch::new(label);
        let archive = scratch.0.join("archive");
        let built = oriel_test_archive::build_archive(&archive);
        add_extras(&archive);
        Some(Bench::over(scratch, archive, media, built.videos))
    }

    /// An engine over `archive`, already built, with it added, scanned and analysed.
    fn over(scratch: Scratch, archive: PathBuf, media: Media, videos: bool) -> Bench {
        let data = DataRoot::at(scratch.0.join("data")).unwrap();
        let engine = block_on(TidyEngine::open_with(
            data.clone(),
            data.tidy_catalog(),
            media.clone(),
        ))
        .unwrap();
        let root = block_on(engine.add_root(&archive)).unwrap();
        let scanned = engine.scan(root.id).run(&Quiet::new()).unwrap();
        if scanned.analysis_due {
            engine
                .analyze(root.id, AnalysisKind::CatchingUp)
                .run(&Quiet::new())
                .unwrap();
        }
        let archive = PathBuf::from(&root.path);
        let before = Tree::of(&archive);
        let bench = Bench {
            engine,
            root,
            holding: data.tidy_holding(),
            media,
            videos,
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
            .follow_up(follow_up.clone())
            .run(&self.quiet())
            .unwrap();
    }

    /// Makes a change as the app does, with what it leaves for the engine to do after.
    fn perform(&self, request: PlanRequest) -> PlanSummary {
        let performed = self.engine.perform(request).run(&self.quiet()).unwrap();
        self.follow_up(&performed.applied.follow_up);
        let plan = performed.applied.plan;
        assert_eq!(plan.status, PlanStatus::Applied, "{plan:?}");
        assert_eq!(plan.failed, 0, "{plan:?}");
        plan
    }

    /// Undoes plans, newest first, as one Undo does; every one must come back.
    fn undo(&self, plans: &[PlanId]) {
        let undone = self.engine.undo(plans.to_vec()).run(&self.quiet()).unwrap();
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

    /// The holding batch folders that hold something, each a change's (or Hold's) folder in its
    /// root's folder under holding.
    fn held_batches(&self) -> BTreeSet<PathBuf> {
        self.held()
            .iter()
            .map(|item| {
                let within = Path::new(&item.hold_path)
                    .strip_prefix(&self.holding)
                    .unwrap_or_else(|_| panic!("{item:?} is outside holding"));
                self.holding
                    .join(within.components().take(2).collect::<PathBuf>())
            })
            .collect()
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
        ResolveGroup::of_set(set, set.keep.clone(), remove)
    }

    fn probe(&self, rel: &str) -> oriel_tools::VideoProbe {
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
            Some("photos/cover.avif"),
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
        "photos/cover.avif".into(),
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
    let restored = bench
        .engine
        .restore_holding(vec![junk.id])
        .run(&bench.quiet())
        .unwrap();
    assert_eq!((restored.restored, restored.failed.len()), (1, 0));
    assert_eq!(
        FileState::of(&bench.archive.join("._sunset.png")),
        *bench.before.file("._sunset.png")
    );
    assert_eq!(restored.follow_up.rescan, [bench.root.id]);
    bench.follow_up(&restored.follow_up);
    bench.assert_holding_agrees();

    // The Undo reverses the rest, and its step for the junk counts as undone: that file is back.
    let undone = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&bench.quiet())
        .unwrap();
    bench.follow_up(&undone.follow_up);
    let hold = bench
        .steps(plan.id)
        .into_iter()
        .find(|step| step.action == PlanStepAction::Hold)
        .unwrap();
    assert_eq!(hold.status, StepStatus::Undone);
    assert_eq!(hold.message, None);
    assert_eq!(undone.plans[0].undone, 4);
    assert!(undone.complete, "a file already put back is no failure");
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
            .analyze(bench.root.id, AnalysisKind::AskedFor)
            .run(&bench.quiet())
            .unwrap();
    }
    // A resized and recompressed copy is one picture with its original, however hard its edges.
    let sunset = bench.set_with("photos/sunset.png");
    assert_eq!(sunset.pictures.as_deref(), Some(&[0, 0][..]));
    assert_eq!(sunset.keep.len(), 1);
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

/// Stops an analysis as it starts a phase, and runs `at_phase` as it starts another.
struct Interrupting<'a> {
    token: CancelToken,
    stop_at: &'a str,
    run_at: &'a str,
    at_phase: &'a (dyn Fn() + Sync),
}

impl Progress for Interrupting<'_> {
    fn phase(&self, label: &str, _total: u64) {
        if label == self.stop_at {
            self.token.cancel();
        }
        if label == self.run_at {
            (self.at_phase)();
        }
    }

    fn done(&self, _done: u64) {}

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(&self.token)
    }
}

const PRINTING: &str = "Comparing similar versions";
const LOOKING: &str = "Looking closer at similar versions";

impl Bench {
    fn catalog_path(&self) -> PathBuf {
        DataRoot::at(self._scratch.0.join("data"))
            .unwrap()
            .tidy_catalog()
    }

    fn catalog(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.catalog_path()).unwrap()
    }

    /// A second engine over the catalog, knowing nothing yet, as after a restart.
    fn reopened(&self) -> TidyEngine {
        let data = DataRoot::at(self._scratch.0.join("data")).unwrap();
        block_on(TidyEngine::open_with(
            data,
            self.catalog_path(),
            self.media.clone(),
        ))
        .unwrap()
    }

    fn page(&self, engine: &TidyEngine, scope: DuplicateScope) -> DuplicateSetPage {
        block_on(engine.duplicate_sets(DuplicateSetRequest {
            root_id: Some(self.root.id),
            offset: 0,
            limit: 100,
            level: SimilarityLevel::Balanced,
            scope,
            dismissed: false,
        }))
        .unwrap()
    }

    /// Stopping `engine` at `stop_at`, with `at_phase` run as `run_at` starts.
    fn analyze_until(
        &self,
        engine: &TidyEngine,
        stop_at: &str,
        run_at: &str,
        at_phase: &(dyn Fn() + Sync),
    ) -> anyhow::Result<AnalysisReport> {
        engine
            .analyze(self.root.id, AnalysisKind::AskedFor)
            .run(&Interrupting {
                token: CancelToken::new(),
                stop_at,
                run_at,
                at_phase,
            })
    }

    /// Every answer about `id`, as the size stored for that file.
    fn answers_about(&self, id: FileId) -> Vec<i64> {
        let catalog = self.catalog();
        let mut statement = catalog
            .prepare(
                "SELECT CASE left_id WHEN ?1 THEN left_size ELSE right_size END
                  FROM file_comparisons WHERE left_id = ?1 OR right_id = ?1",
            )
            .unwrap();
        statement
            .query_map([id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
}

fn only_clips(set: &DuplicateSet) -> bool {
    set.versions
        .iter()
        .flat_map(|version| &version.files)
        .all(|file| file.duration_ms.is_some())
}

/// Whether Spot variants would call two files copies, by the rule the sets use.
fn still_copies(vips: &Vips, left: &Path, right: &Path) -> bool {
    let left = look_at_still(vips, left).unwrap();
    let right = look_at_still(vips, right).unwrap();
    !is_variant(
        &normalize_detail(&left.print()),
        &normalize_detail(&right.print()),
    ) && !look_shows_variant(&left, &right)
}

#[test]
fn prints_from_an_older_version_hold_every_set_until_they_are_made_again() {
    let Some(bench) = Bench::open("older-prints") else {
        return;
    };
    let settled = bench.page(&bench.engine, DuplicateScope::Similar);
    assert_eq!(settled.counts.checking, 0);
    assert!(settled.counts.similar > 0);
    assert!(settled.counts.variants > 0);

    // As a catalog arrives from the version before.
    let catalog = bench.catalog();
    catalog
        .execute_batch(
            "UPDATE file_details SET version = 1; UPDATE file_comparisons SET version = 1;",
        )
        .unwrap();
    drop(catalog);
    let engine = bench.reopened();
    assert!(block_on(engine.analysis_due(bench.root.id)).unwrap());
    for scope in [DuplicateScope::Similar, DuplicateScope::Variants] {
        let held = bench.page(&engine, scope);
        // The clips' set has no stills, so it needs nothing and stays.
        let open = held.sets.iter().filter(|set| !only_clips(set)).count();
        assert_eq!(open, 0, "{scope:?} shows {:?}", held.sets);
        assert_eq!(held.counts.similar, i64::from(bench.videos));
        assert_eq!(held.counts.variants, 0);
        assert_eq!(
            held.counts.checking,
            settled.counts.similar + settled.counts.variants - i64::from(bench.videos)
        );
    }
    // Nothing is offered for removal meanwhile, anywhere in the app.
    let overview = block_on(engine.overview(bench.root.id)).unwrap();
    assert_eq!(overview.duplicates.similar.sets, i64::from(bench.videos));

    engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    assert!(!block_on(engine.analysis_due(bench.root.id)).unwrap());
    let back = bench.page(&engine, DuplicateScope::Similar);
    assert_eq!(back.counts.checking, 0);
    assert_eq!(back.counts.similar, settled.counts.similar);
    assert_eq!(back.counts.variants, settled.counts.variants);
}

#[test]
fn a_stopped_analysis_leaves_sets_held_and_the_next_one_finishes_them() {
    let Some(bench) = Bench::open("stopped") else {
        return;
    };
    let settled = bench.page(&bench.engine, DuplicateScope::Similar);
    let catalog = bench.catalog();
    catalog
        .execute_batch("DELETE FROM file_details; DELETE FROM file_comparisons;")
        .unwrap();
    drop(catalog);
    let engine = bench.reopened();

    for stop_at in [PRINTING, LOOKING] {
        let stopped = bench.analyze_until(&engine, stop_at, "", &|| {});
        assert!(stopped.is_err(), "{stop_at} should have stopped it");
        let held = bench.page(&engine, DuplicateScope::Similar);
        assert!(held.counts.checking > 0, "after stopping at {stop_at}");
        assert!(block_on(engine.analysis_due(bench.root.id)).unwrap());
        // What could not be finished is not on offer, nor can it be marked as not duplicates: the
        // sunset and the page wait on a look, whichever phase it stopped in.
        for scope in [DuplicateScope::Similar, DuplicateScope::Variants] {
            for set in bench.page(&engine, scope).sets {
                let rels: Vec<&str> = set
                    .versions
                    .iter()
                    .flat_map(|version| &version.files)
                    .map(|file| file.rel_path.as_str())
                    .collect();
                assert!(
                    !rels.contains(&"photos/sunset.png")
                        && !rels.contains(&"pages/fanbox/101_jp.png"),
                    "{scope:?} shows {rels:?} after stopping at {stop_at}"
                );
            }
        }
    }

    engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    let back = bench.page(&engine, DuplicateScope::Similar);
    assert_eq!(back.counts.checking, 0);
    assert_eq!(back.counts.similar, settled.counts.similar);
    assert_eq!(back.counts.variants, settled.counts.variants);
}

#[test]
fn a_look_at_a_file_that_changes_under_it_is_taken_again() {
    let Some(bench) = Bench::open("changes-under-look") else {
        return;
    };
    let sunset = bench.id("photos/sunset.png");
    let original_size = bench.answers_about(sunset)[0];
    let catalog = bench.catalog();
    catalog
        .execute_batch("DELETE FROM file_comparisons;")
        .unwrap();
    drop(catalog);
    let engine = bench.reopened();
    let change = || {
        // As a scan would see the file: new bytes, so a new size, and its fingerprint gone.
        let catalog = bench.catalog();
        catalog
            .execute(
                "UPDATE files SET size = size + 1, fingerprint = NULL, fingerprint_version = 0
                  WHERE id = ?1",
                [sunset],
            )
            .unwrap();
    };
    bench.analyze_until(&engine, "", LOOKING, &change).unwrap();
    // No answer was kept about bytes that are gone.
    assert_eq!(bench.answers_about(sunset), Vec::<i64>::new());

    // The change calls for an analysis, which fingerprints the file and looks again, once a scan
    // has caught the catalog up with the file, which never changed on disk.
    assert!(block_on(engine.analysis_due(bench.root.id)).unwrap());
    let scanned = engine.scan(bench.root.id).run(&bench.quiet()).unwrap();
    assert!(scanned.analysis_due);
    engine
        .analyze(bench.root.id, AnalysisKind::CatchingUp)
        .run(&bench.quiet())
        .unwrap();
    assert_eq!(bench.answers_about(sunset), [original_size]);
    assert_eq!(bench.page(&engine, DuplicateScope::All).counts.checking, 0);
}

#[test]
fn a_still_that_will_not_decode_gets_a_final_answer_that_keeps_it() {
    let Some(bench) = Bench::open("undecodable") else {
        return;
    };
    let (sunset, small) = (
        bench.id("photos/sunset.png"),
        bench.id("photos/sunset-small.jpg"),
    );
    let catalog = bench.catalog();
    catalog
        .execute_batch("DELETE FROM file_details; DELETE FROM file_comparisons;")
        .unwrap();
    drop(catalog);
    // Bytes that cannot be read, with the catalog none the wiser until the next scan.
    fs::write(
        bench.archive.join("photos/sunset-small.jpg"),
        b"not a picture",
    )
    .unwrap();
    let engine = bench.reopened();
    engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();

    let page = bench.page(&engine, DuplicateScope::Variants);
    assert_eq!(page.counts.checking, 0, "it is not held forever");
    let set = page
        .sets
        .iter()
        .find(|set| ids_of(set).contains(&small))
        .unwrap();
    let mut kept = set.keep.clone();
    kept.sort_unstable();
    let mut both = vec![sunset, small];
    both.sort_unstable();
    assert_eq!(kept, both, "both files stay");
    assert_eq!(set.reclaimable_bytes, 0);
    assert!(!block_on(engine.analysis_due(bench.root.id)).unwrap());
}

#[test]
fn a_converted_still_stays_a_copy_and_no_answer_outlives_its_file() {
    let Some(bench) = Bench::open("convert-copies") else {
        return;
    };
    let vips = bench.media.loaded_vips().unwrap();
    let sunset = bench.id("photos/sunset.png");
    let before = bench.set_with("photos/sunset.png");
    assert_eq!(before.pictures.as_deref(), Some(&[0, 0][..]));
    assert_eq!(bench.answers_about(sunset).len(), 1);
    let original_size = bench.answers_about(sunset)[0];

    let plan = bench.perform(PlanRequest::Optimize {
        root_id: bench.root.id,
        categories: vec![OptimizeCategory::StillToAvif],
        file_ids: Some(vec![sunset]),
    });
    // It kept its id, and is a copy both of what it was and of the other file in its set.
    assert_eq!(bench.id("photos/sunset.avif"), sunset);
    let held = &bench.held_by_original()["photos/sunset.png"];
    let result = bench.archive.join("photos/sunset.avif");
    let source = bench
        .held()
        .into_iter()
        .find(|item| bench.rel(&item.original_path) == "photos/sunset.png")
        .map(|item| PathBuf::from(item.hold_path))
        .unwrap();
    assert_eq!(FileState::of(&source), held.0);
    assert!(still_copies(vips, &source, &result));
    assert!(still_copies(
        vips,
        &result,
        &bench.archive.join("photos/sunset-small.jpg")
    ));
    let converted = bench.set_with("photos/sunset.avif");
    assert_eq!(converted.key, before.key);
    assert_eq!(converted.pictures.as_deref(), Some(&[0, 0][..]));
    assert_eq!(converted.keep.len(), 1);
    // The answer is about the new bytes, not the old.
    let size = fs::metadata(&result).unwrap().len() as i64;
    assert_ne!(size, original_size);
    assert_eq!(bench.answers_about(sunset), [size]);

    bench.undo_and_check(&[plan.id], "Convert of a similar still");
    assert_eq!(bench.id("photos/sunset.png"), sunset);
    assert_eq!(bench.answers_about(sunset), [original_size]);
    let undone = bench.set_with("photos/sunset.png");
    assert_eq!(undone.key, before.key);
    assert_eq!(undone.pictures.as_deref(), Some(&[0, 0][..]));
    let page = bench.page(&bench.engine, DuplicateScope::All);
    assert_eq!(page.counts.checking, 0);
}

#[test]
fn an_av1_re_encode_stays_a_copy_and_stays_in_its_set() {
    let Some(bench) = Bench::open("av1-copies") else {
        return;
    };
    if !bench.videos {
        return;
    }
    let small = "clips/with-sound-small.mp4";
    let before = bench.set_with(small);
    assert_eq!(before.pictures, None);
    let id = bench.id(small);
    let plan = bench.perform(PlanRequest::Reencode {
        file_ids: vec![id],
        codec: VideoCodecChoice::Av1,
        quality: VideoQuality::High,
    });
    assert_eq!(bench.id(small), id);
    let shrunk = bench.set_with(small);
    assert_eq!(shrunk.key, before.key);
    assert_eq!(shrunk.pictures, None, "still one piece of footage");
    assert_eq!(shrunk.keep.len(), 1);
    assert_eq!(ids_of(&shrunk), ids_of(&before));
    // The byte-identical pair inside the set stays one version.
    assert!(
        shrunk
            .versions
            .iter()
            .any(|version| version.files.len() == 2)
    );
    assert_eq!(
        bench
            .page(&bench.engine, DuplicateScope::All)
            .counts
            .checking,
        0
    );

    bench.undo_and_check(&[plan.id], "an AV1 re-encode in a set");
    let undone = bench.set_with(small);
    assert_eq!(undone.key, before.key);
    assert_eq!(undone.pictures, None);
    assert_eq!(ids_of(&undone), ids_of(&before));
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
    // Members of open duplicate sets are converted like any other file.
    for (from, to) in [
        ("photos/sunset.png", "photos/sunset.avif"),
        ("photos/forest.png", "photos/forest.avif"),
        ("pages/fanbox/101_jp.png", "pages/fanbox/101_jp.avif"),
    ] {
        assert_eq!(converted.get(from).map(String::as_str), Some(to), "{from}");
    }
    bench.assert_holding_agrees();

    bench.undo_and_check(&[plan.id], "Convert");
    // The results wait in holding, as an undone conversion's do.
    let held = bench.held_by_original();
    for to in converted.values() {
        assert_eq!(held[to].1, "Undone conversion", "{to}");
    }
}

/// What History says of a copy's step that took its identical copy's result.
const SAME_RESULT: &str = "Same result as its identical copy";

/// Whether the steps from these files, in any order, ran one encode and shared it with the rest.
fn assert_one_encode(steps: &[Step], copies: &[&str]) {
    let of_copies: Vec<&Step> = steps
        .iter()
        .filter(|step| copies.contains(&step.from.as_str()))
        .collect();
    assert_eq!(of_copies.len(), copies.len(), "{steps:?}");
    assert!(of_copies.iter().all(|step| step.status == StepStatus::Done));
    let reused = of_copies
        .iter()
        .filter(|step| step.message.as_deref() == Some(SAME_RESULT))
        .count();
    assert_eq!(reused, copies.len() - 1, "{of_copies:?}");
}

/// The files of a set, sorted by id.
fn ids_of(set: &DuplicateSet) -> Vec<FileId> {
    let mut ids: Vec<FileId> = set
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .map(|file| file.id)
        .collect();
    ids.sort_unstable();
    ids
}

#[test]
fn identical_copies_stay_identical_through_convert_with_one_encode() {
    let Some(bench) = Bench::open("copies-convert") else {
        return;
    };
    let originals = [
        "photos/forest.png",
        "dup/forest (1).png",
        "photos/forest copy.png",
    ];
    let results = [
        "photos/forest.avif",
        "dup/forest (1).avif",
        "photos/forest copy.avif",
    ];
    let before = bench.set_with(originals[0]);
    assert_eq!(before.kind, DuplicateKind::Exact);
    let request = PlanRequest::Optimize {
        root_id: bench.root.id,
        categories: vec![OptimizeCategory::StillToAvif],
        file_ids: None,
    };

    let plan = bench.perform(request.clone());
    assert_one_encode(&bench.steps(plan.id), &originals);
    // Still one identical set, of the same files, and resolvable as one, with no scan since.
    let after = bench.set_with(results[0]);
    assert_eq!(after.kind, DuplicateKind::Exact, "{after:?}");
    assert_eq!(ids_of(&after), ids_of(&before));
    assert_eq!(after.key, before.key);
    let now = Tree::of(&bench.archive);
    assert_eq!(now.file(results[1]).sha256, now.file(results[0]).sha256);
    assert_eq!(now.file(results[2]).sha256, now.file(results[0]).sha256);
    // Each copy's original waits in holding, with its own bytes.
    for original in originals {
        assert_eq!(
            &bench.held_by_original()[original].0,
            bench.before.file(original)
        );
    }

    bench.undo_and_check(&[plan.id], "Convert of identical copies");
    let undone = bench.set_with(originals[0]);
    assert_eq!(undone.kind, DuplicateKind::Exact);
    assert_eq!(ids_of(&undone), ids_of(&before));

    // Changed again, the set can still be resolved, and that taken back too.
    let plan = bench.perform(request.clone());
    let resolved = bench.perform(PlanRequest::ResolveDuplicates {
        groups: vec![bench.suggestion(&bench.set_with(results[0]))],
    });
    let left = Tree::of(&bench.archive);
    let kept = results.iter().filter(|rel| left.files.contains_key(**rel));
    assert_eq!(kept.count(), 1);
    bench.undo_and_check(&[plan.id, resolved.id], "resolving converted copies");

    // A set the owner dismissed stays dismissed through the change and its undo.
    let set = ids_of(&bench.set_with(originals[0]));
    block_on(bench.engine.dismiss_duplicate_set(set.clone())).unwrap();
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
        .sets
        .iter()
        .map(ids_of)
        .collect::<Vec<_>>()
    };
    let plan = bench.perform(request);
    assert_eq!(dismissed(), std::slice::from_ref(&set));
    bench.undo(&[plan.id]);
    assert_eq!(dismissed(), [set]);
}

#[test]
fn identical_copies_stay_identical_through_shrink_with_one_encode() {
    let (Some(media), Some(_)) = (support::media(), oriel_test_archive::media_tools()) else {
        return;
    };
    let scratch = Scratch::new("copies-shrink");
    let archive = scratch.0.join("shrink-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    fs::remove_file(archive.join("tiny.mp4")).ok();
    fs::create_dir_all(archive.join("copies")).unwrap();
    let busy = archive.join("clips/busy.mp4");
    fs::copy(&busy, archive.join("copies/busy.mp4")).unwrap();
    fs::hard_link(&busy, archive.join("clips/busy link.mp4")).unwrap();
    let bench = Bench::over(scratch, archive, media, true);
    let copies = ["clips/busy.mp4", "copies/busy.mp4", "clips/busy link.mp4"];
    let before = bench.set_with(copies[0]);
    assert_eq!(before.kind, DuplicateKind::Exact);

    // Shrink counts one encode, and each file's bytes once.
    let summary = block_on(bench.engine.shrink_summary(bench.root.id)).unwrap();
    let items: Vec<_> = summary
        .items
        .iter()
        .filter(|item| ids_of(&before).contains(&item.file_id))
        .collect();
    assert_eq!(items.len(), 3, "{items:?}");
    assert_eq!(items.iter().filter(|item| item.encode_ms > 0.).count(), 1);
    assert_eq!(
        items.iter().filter(|item| item.copy_of.is_none()).count(),
        1
    );
    assert_eq!(items.iter().filter(|item| item.bytes > 0).count(), 2);
    // What the Overview shows beside the duplicates' totals leaves out what resolving them frees.
    let tidy = block_on(bench.engine.overview(bench.root.id)).unwrap();
    let saved_per_file = items[0].bytes - items[0].estimated_bytes;
    assert_eq!(tidy.shrink.duplicate_saving, saved_per_file);

    // Change one copy alone: it becomes a similar version of the others, and the suggestion keeps
    // the saving rather than the larger bytes.
    let first = bench.perform(PlanRequest::Reencode {
        file_ids: vec![bench.id(copies[1])],
        codec: VideoCodecChoice::Av1,
        quality: VideoQuality::High,
    });
    let split = bench.set_with(copies[0]);
    assert_eq!(split.kind, DuplicateKind::Similar, "{split:?}");
    assert_eq!(ids_of(&split), ids_of(&before));
    assert_eq!(split.key, before.key);
    assert_eq!(split.keep, [bench.id(copies[1])]);
    assert_eq!(split.keep_reason, KeepReason::AlreadyReencoded);

    // The rest take that result, in a later plan, encoding nothing: the set is whole again, and
    // the hard link is still one file with what it links to, so no new copy appears.
    let rest = bench.perform(PlanRequest::ShrinkVideos {
        root_id: bench.root.id,
        limit_bytes: None,
    });
    for step in bench
        .steps(rest.id)
        .iter()
        .filter(|step| copies.contains(&step.from.as_str()))
    {
        assert_eq!(step.message.as_deref(), Some(SAME_RESULT), "{step:?}");
    }
    let after = bench.set_with(copies[0]);
    assert_eq!(after.kind, DuplicateKind::Exact, "{after:?}");
    assert_eq!(ids_of(&after), ids_of(&before));
    let now = Tree::of(&bench.archive);
    assert_eq!(now.file(copies[1]).sha256, now.file(copies[0]).sha256);
    assert_eq!(now.file(copies[2]).sha256, now.file(copies[0]).sha256);
    assert!(now.file(copies[0]).size < bench.before.file(copies[0]).size);
    assert_eq!(after.hard_linked_ids.len(), 2, "{after:?}");

    bench.undo_and_check(&[first.id, rest.id], "Shrink of identical copies");
    let undone = bench.set_with(copies[0]);
    assert_eq!(undone.kind, DuplicateKind::Exact);
    assert_eq!(ids_of(&undone), ids_of(&before));
    assert_eq!(undone.hard_linked_ids.len(), 2, "{undone:?}");
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
        .tidy_up(bench.root.id, CONVERT.to_vec())
        .run(&bench.quiet())
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
    assert!(now.files.contains_key("photos/cover.avif"));
    assert!(!now.folders.contains("empty"));
    assert!(!now.files.contains_key("._sunset.png"));
    assert!(now.files.contains_key("extra/harbour.avif"));
    // Duplicates are not a step: copies are converted, and every one of them stays.
    for copy in ["photos/forest copy.avif", "dup/forest (1).avif"] {
        assert!(now.files.contains_key(copy), "{copy}");
    }
    assert_eq!(
        bench.set_with("photos/forest copy.avif").kind,
        DuplicateKind::Exact
    );
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

    // One Undo of all three, newest first. The folder the move made stays, empty; every file is
    // back.
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
    let (Some(media), Some(_)) = (support::media(), oriel_test_archive::media_tools()) else {
        return;
    };
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

/// Emptying holding takes its batch folders away (into the sandboxed run's own trash), and what
/// went cannot come back.
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
    assert_eq!(bench.held_batches().len(), 1, "one change, one batch");
    let emptied = bench
        .engine
        .empty_holding(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    assert_eq!((emptied.emptied, emptied.failed.len()), (3, 0));
    assert!(bench.held().is_empty());
    assert!(Tree::of(&bench.holding).files.is_empty());
    bench.assert_holding_agrees();

    // What was emptied cannot come back; the rest of the change still undoes.
    let undone = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&bench.quiet())
        .unwrap();
    bench.follow_up(&undone.follow_up);
    let now = Tree::of(&bench.archive);
    assert!(now.files.contains_key("photos/cover.jpg"));
    assert!(now.folders.contains("empty"));
    assert!(!now.files.contains_key("._sunset.png"));
}

/// The answers in the catalog: how many, and how many of them say copies.
fn answers(bench: &Bench) -> (i64, i64) {
    bench
        .catalog()
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(variant = 0), 0) FROM file_comparisons",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

/// The bench's engine as it would be with no libvips to load.
fn without_libvips(bench: &Bench) -> TidyEngine {
    let data = DataRoot::at(bench._scratch.0.join("data")).unwrap();
    let media = Media {
        vips: None,
        ffmpeg: None,
        ffprobe: None,
    };
    block_on(TidyEngine::open_with(data, bench.catalog_path(), media)).unwrap()
}

#[test]
fn a_closer_look_without_libvips_answers_nothing_until_it_returns() {
    let Some(bench) = Bench::open("looks-no-libvips") else {
        return;
    };
    let (_, copies) = answers(&bench);
    assert!(copies > 0);
    bench
        .catalog()
        .execute("DELETE FROM file_comparisons", [])
        .unwrap();
    let without = without_libvips(&bench);
    without
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&Quiet::new())
        .unwrap();
    assert_eq!(answers(&bench), (0, 0), "no answer can be given");
    drop(without);
    let again = bench.reopened();
    again
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&Quiet::new())
        .unwrap();
    assert_eq!(answers(&bench).1, copies);
}

#[test]
fn a_pair_that_could_not_be_read_keeps_both_and_is_asked_again() {
    let Some(bench) = Bench::open("looks-unread") else {
        return;
    };
    let (_, copies) = answers(&bench);
    assert!(copies > 0);
    let catalog = bench.catalog();
    let path: String = catalog
        .query_row(
            "SELECT f.rel_path FROM file_comparisons c JOIN files f ON f.id = c.left_id
              WHERE c.variant = 0 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    catalog.execute("DELETE FROM file_comparisons", []).unwrap();
    // The file is out of reach, as on a volume gone offline, where the catalog cannot see it.
    let aside = bench.archive.join("aside.png.tmp");
    let file = bench.archive.join(&path);
    fs::rename(&file, &aside).unwrap();
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    let unread: i64 = catalog
        .query_row(
            "SELECT COUNT(*) FROM file_comparisons WHERE variant = 2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(unread > 0);
    assert!(answers(&bench).1 < copies, "no copy on a file unread");
    assert!(block_on(bench.engine.analysis_due(bench.root.id)).unwrap());

    fs::rename(&aside, &file).unwrap();
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    assert_eq!(answers(&bench).1, copies);
}

/// A still, its AVIF, and those bytes with one bit flipped near the end of the coded data, where
/// the hardware route reads it and libvips refuses it. `None` when this machine has no such route.
#[cfg(target_os = "macos")]
fn a_damaged_avif(media: &Media, scratch: &Scratch) -> Option<(PathBuf, PathBuf, Vec<u8>)> {
    use oriel_core_tidy::internals::StillLook;
    use oriel_core_tidy::internals::encode_still_to_avif;
    use oriel_test_archive::image::{Rgba, RgbaImage};

    let vips = media.loaded_vips().unwrap();
    let libavif = oriel_test_archive::libavif().unwrap();
    let random = |state: &mut u64| {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    };
    let mut noise = 0xfeed_face_dead_beef_u64;
    let picture = RgbaImage::from_fn(1200, 900, |x, y| {
        let shade = (((x / 64) ^ (y / 64)) % 7 * 30) as u8;
        let grain = (random(&mut noise) % 24) as u8;
        Rgba([
            shade.wrapping_add(grain),
            shade / 2 + grain,
            200u8.saturating_sub(shade) / 2 + grain,
            255,
        ])
    });
    let source = scratch.0.join("source.png");
    save_png(&picture, &source, CompressionType::Fast);
    let good = scratch.0.join("good.avif");
    encode_still_to_avif(vips, libavif, &source, &good).unwrap();
    if !matches!(vips.hardware_route(&good), Ok(Ok(()))) {
        eprintln!("skipped: this Mac has no hardware route for it");
        return None;
    }

    // One flipped bit near the end of the coded data, which spoils only the last of the picture.
    let original = fs::read(&good).unwrap();
    let good_look = look_at_still(vips, &good).unwrap();
    let probe = scratch.0.join("probe.avif");
    let mut flips = 0x0123_4567_89ab_cdef_u64;
    let bytes = (0..200).find_map(|_| {
        let mut bytes = original.clone();
        let at = bytes.len() - 1 - (random(&mut flips) as usize) % 400;
        bytes[at] ^= 1 << (random(&mut flips) % 8);
        fs::write(&probe, &bytes).unwrap();
        let called_a_copy = vips.rgba_pixels(&probe).is_ok_and(|(width, height, rgba)| {
            let look = StillLook::from_rgba(width, height, &rgba).unwrap();
            !look_shows_variant(&good_look, &look) && look_at_still(vips, &probe).is_err()
        });
        called_a_copy.then_some(bytes)
    });
    fs::remove_file(&probe).unwrap();
    Some((
        source,
        good,
        bytes.expect("no flip the hardware route calls a copy"),
    ))
}

/// A damaged AVIF the hardware route reads, gets a print from and would call a copy of its good
/// original: only libvips, which refuses it, may answer, so nothing is offered for removal.
#[cfg(target_os = "macos")]
#[test]
fn a_damaged_still_the_hardware_route_reads_keeps_both_files() {
    let Some(media) = support::media() else {
        return;
    };
    let scratch = Scratch::new("damaged-pair");
    let Some((_, good, bytes)) = a_damaged_avif(&media, &scratch) else {
        return;
    };
    let archive = scratch.0.join("archive");
    fs::create_dir_all(&archive).unwrap();
    fs::copy(&good, archive.join("z-good.avif")).unwrap();
    fs::write(archive.join("a-damaged.avif"), &bytes).unwrap();

    let bench = Bench::over(scratch, archive, media.clone(), false);
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    let id = bench.id("a-damaged.avif");
    let catalog = bench.catalog();
    let printed: bool = catalog
        .query_row(
            "SELECT fingerprint IS NOT NULL FROM files WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(printed, "the hardware route gives it a print");
    let told: Vec<i64> = catalog
        .prepare("SELECT variant FROM file_comparisons")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(told, [2], "it could not be read, and is no copy");
    let sets = bench.duplicate_sets(DuplicateScope::Variants);
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0].keep.len(), 2, "both files stay");
    assert_eq!(sets[0].reclaimable_bytes, 0);
    assert!(bench.duplicate_sets(DuplicateScope::All).is_empty());
    assert!(block_on(bench.engine.analysis_due(bench.root.id)).unwrap());
    assert_eq!(
        fs::read(bench.archive.join("a-damaged.avif")).unwrap(),
        bytes
    );
}

/// With Spot variants off the set keeps one file, and the archive format would pick the AVIF. Its
/// print rests on the hardware route alone: libvips must read it before its original can go.
#[cfg(target_os = "macos")]
#[test]
fn with_spot_variants_off_a_damaged_still_never_replaces_its_original() {
    let Some(media) = support::media() else {
        return;
    };
    let scratch = Scratch::new("spot-off-damage");
    let Some((source, _, bytes)) = a_damaged_avif(&media, &scratch) else {
        return;
    };
    let archive = scratch.0.join("archive");
    fs::create_dir_all(&archive).unwrap();
    let bench = Bench::over(scratch, archive, media, false);
    let mut settings = block_on(bench.engine.settings()).unwrap();
    settings.spot_variants = false;
    block_on(bench.engine.update_settings(settings)).unwrap();
    fs::copy(&source, bench.archive.join("photo.png")).unwrap();
    fs::write(bench.archive.join("photo.avif"), &bytes).unwrap();
    let scanned = bench
        .engine
        .scan(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    if scanned.analysis_due {
        bench
            .engine
            .analyze(bench.root.id, AnalysisKind::CatchingUp)
            .run(&bench.quiet())
            .unwrap();
    }
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();

    let sets: Vec<DuplicateSet> = [DuplicateScope::All, DuplicateScope::Variants]
        .into_iter()
        .flat_map(|scope| bench.duplicate_sets(scope))
        .collect();
    assert_eq!(sets.len(), 1, "the hardware route's print made the set");
    let names = |ids: &[FileId]| -> Vec<String> {
        sets[0]
            .versions
            .iter()
            .flat_map(|version| &version.files)
            .filter(|file| ids.contains(&file.id))
            .map(|file| file.name.clone())
            .collect()
    };
    assert_eq!(
        names(&sets[0].keep).len(),
        2,
        "keeps {:?} for {:?}",
        names(&sets[0].keep),
        sets[0].keep_reason
    );
    assert_eq!(sets[0].reclaimable_bytes, 0);
    let answers: i64 = bench
        .catalog()
        .query_row(
            "SELECT COUNT(*) FROM file_comparisons WHERE variant = 2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(answers, 1, "it could not be read");
}

/// Answers a pair got only because it could not be read, with nothing else for an analysis to do.
fn answers_made_unread(bench: &Bench) -> i64 {
    bench
        .catalog()
        .execute(
            "UPDATE file_comparisons SET variant = 2 WHERE variant = 0",
            [],
        )
        .unwrap() as i64
}

/// Stores pairs of a bench's archive as unread, the file they need put back afterwards.
fn pairs_left_unread(bench: &Bench) -> (i64, PathBuf, PathBuf) {
    let catalog = bench.catalog();
    let path: String = catalog
        .query_row(
            "SELECT f.rel_path FROM file_comparisons c JOIN files f ON f.id = c.left_id
              WHERE c.variant = 0 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    catalog.execute("DELETE FROM file_comparisons", []).unwrap();
    let (file, aside) = (bench.archive.join(&path), bench.archive.join("aside.tmp"));
    fs::rename(&file, &aside).unwrap();
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();
    (unread(bench), file, aside)
}

fn unread(bench: &Bench) -> i64 {
    bench
        .catalog()
        .query_row(
            "SELECT COUNT(*) FROM file_comparisons WHERE variant = 2",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

/// Plants an unread answer about two files nothing compares, which only an analysis asking again
/// takes away: it says whether one ran.
fn plant_unread_answer(bench: &Bench) -> (FileId, FileId) {
    let catalog = bench.catalog();
    let (left, right) = catalog
        .query_row(
            "SELECT MIN(id), MAX(id) FROM files WHERE id NOT IN
               (SELECT left_id FROM file_comparisons UNION SELECT right_id FROM file_comparisons)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    catalog
        .execute(
            "INSERT INTO file_comparisons (left_id, right_id, version, left_size, left_mtime_ms,
               right_size, right_mtime_ms, variant)
             SELECT l.id, r.id, ?3, l.size, l.mtime_ms, r.size, r.mtime_ms, 2
               FROM files l, files r WHERE l.id = ?1 AND r.id = ?2",
            rusqlite::params![left, right, DETAIL_VERSION],
        )
        .unwrap();
    (left, right)
}

fn answer_stands(bench: &Bench, (left, right): (FileId, FileId)) -> bool {
    bench
        .catalog()
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM file_comparisons WHERE left_id = ?1 AND right_id = ?2)",
            [left, right],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn pairs_that_could_not_be_read_are_asked_again_when_a_scan_ends() {
    let Some(bench) = Bench::open("unread-scan") else {
        return;
    };
    assert!(answers_made_unread(&bench) > 0);

    // A decision's analysis does not ask: a damaged file would be read at every one.
    let planted = plant_unread_answer(&bench);
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AfterChange)
        .run(&bench.quiet())
        .unwrap();
    assert!(answer_stands(&bench, planted));

    let scanned = bench
        .engine
        .scan(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    assert!(scanned.analysis_due);
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::CatchingUp)
        .run(&bench.quiet())
        .unwrap();
    assert_eq!(unread(&bench), 0, "the scan's analysis asks again");

    // A rescan a change asks for ends in the same catch-up.
    assert!(answers_made_unread(&bench) > 0);
    bench.follow_up(&FollowUp {
        rescan: vec![bench.root.id],
        analyze: Vec::new(),
    });
    assert_eq!(unread(&bench), 0);
}

#[test]
fn pairs_that_could_not_be_read_are_asked_again_at_launch_and_only_then() {
    let Some(bench) = Bench::open("unread-launch") else {
        return;
    };
    let (count, _file, _aside) = pairs_left_unread(&bench);
    assert!(count > 0);

    // Still unreadable: one more try at launch, and it stays that way.
    let launched = bench.reopened();
    assert!(block_on(launched.analysis_due(bench.root.id)).unwrap());
    let planted = plant_unread_answer(&bench);
    launched
        .analyze(bench.root.id, AnalysisKind::CatchingUp)
        .run(&bench.quiet())
        .unwrap();
    assert!(!answer_stands(&bench, planted), "it asked again");
    assert_eq!(unread(&bench), count);

    // That is the end of it: nothing but the next launch or scan asks once more.
    let planted = plant_unread_answer(&bench);
    launched
        .analyze(bench.root.id, AnalysisKind::AfterChange)
        .run(&bench.quiet())
        .unwrap();
    assert!(answer_stands(&bench, planted));
}

/// The file kept is what makes the others safe to take away: a keeper changed or gone since the
/// scan leaves them alone, and the scan that catches the catalog up follows.
#[test]
fn a_copy_goes_only_while_the_file_kept_is_as_the_scan_saw_it() {
    type Change = fn(&Path);
    let changes: [(&str, Change); 4] = [
        ("overwritten", |kept| {
            fs::write(kept, b"something else").unwrap()
        }),
        // Only the bytes tell this one apart: the change time moved, so the hash decides.
        ("overwritten with the same size and date", |kept| {
            let before = fs::metadata(kept).unwrap();
            fs::write(kept, vec![0x5a; before.len() as usize]).unwrap();
            set_mtime(kept, before.modified().unwrap());
        }),
        ("deleted", |kept| fs::remove_file(kept).unwrap()),
        ("moved away", |kept| {
            fs::rename(kept, kept.with_extension("gone")).unwrap();
        }),
    ];
    for (name, change) in changes {
        let Some(bench) = Bench::open("kept-changed") else {
            return;
        };
        let set = bench
            .duplicate_sets(DuplicateScope::All)
            .into_iter()
            .find(|set| set.kind == DuplicateKind::Exact)
            .unwrap();
        let group = bench.suggestion(&set);
        let kept = set
            .versions
            .iter()
            .flat_map(|version| &version.files)
            .find(|file| group.keep.contains(&file.id))
            .unwrap();
        let going: Vec<PathBuf> = set
            .versions
            .iter()
            .flat_map(|version| &version.files)
            .filter(|file| group.remove.contains(&file.id))
            .map(|file| bench.archive.join(&file.rel_path))
            .collect();
        assert!(!going.is_empty());
        change(&bench.archive.join(&kept.rel_path));

        let performed = bench
            .engine
            .perform(PlanRequest::ResolveDuplicates {
                groups: vec![group],
            })
            .run(&bench.quiet())
            .unwrap();
        assert!(
            bench.held().is_empty(),
            "{name}: {:?}",
            performed.applied.plan
        );
        for file in &going {
            assert!(file.is_file(), "{name}");
        }
        assert_eq!(
            performed.applied.follow_up.rescan,
            [bench.root.id],
            "{name}"
        );
        // It says so, and claims nothing: every step went for the file kept, and none was done.
        let plan = &performed.applied.plan;
        assert_eq!(plan.done, 0, "{name}");
        assert_eq!(plan.skipped_for_kept_file, plan.skipped, "{name}");
        assert_eq!(plan.title, "Nothing resolved", "{name}");
        let steps = bench.steps(performed.applied.plan.id);
        assert!(
            steps.iter().all(|step| step.status == StepStatus::Skipped),
            "{name}: {steps:?}"
        );
    }
}

/// A plan that left every copy alone cannot be undone, so its mark must not stay to hide the set.
#[test]
fn a_decision_that_moved_nothing_marks_nothing() {
    let Some(bench) = Bench::open("kept-no-mark") else {
        return;
    };
    let set = bench
        .duplicate_sets(DuplicateScope::All)
        .into_iter()
        .find(|set| set.keep.len() > 1)
        .expect("a set keeping two pictures");
    let group = bench.suggestion(&set);
    let last = set
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .rfind(|file| group.keep.contains(&file.id))
        .unwrap();
    fs::write(bench.archive.join(&last.rel_path), b"something else").unwrap();
    let marks_before: i64 = bench
        .catalog()
        .query_row("SELECT COUNT(*) FROM duplicate_dismissals", [], |row| {
            row.get(0)
        })
        .unwrap();
    let performed = bench
        .engine
        .perform(PlanRequest::ResolveDuplicates {
            groups: vec![group],
        })
        .run(&bench.quiet())
        .unwrap();
    assert_eq!(performed.applied.plan.done, 0);
    let marks: i64 = bench
        .catalog()
        .query_row("SELECT COUNT(*) FROM duplicate_dismissals", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(marks, marks_before);
}

/// Done, its mark stays, for its Undo to take back.
#[test]
fn a_decision_that_moved_copies_keeps_its_mark() {
    let Some(bench) = Bench::open("kept-mark") else {
        return;
    };
    let set = bench
        .duplicate_sets(DuplicateScope::All)
        .into_iter()
        .find(|set| set.keep.len() > 1)
        .expect("a set keeping two pictures");
    let plan = bench.perform(PlanRequest::ResolveDuplicates {
        groups: vec![bench.suggestion(&set)],
    });
    assert!(plan.done > 0);
    let marks: i64 = bench
        .catalog()
        .query_row(
            "SELECT COUNT(*) FROM duplicate_dismissals WHERE plan_id = ?1",
            [plan.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marks, 1);
}

/// In a sandboxed run, as every test is, Empty to Trash goes to the run's own trash: it reports
/// what it would and takes the files out of holding, and the owner's Trash never sees them.
#[test]
fn a_sandboxed_run_empties_holding_into_its_own_trash() {
    let Some(bench) = Bench::open("sandbox-trash") else {
        return;
    };
    bench.perform(PlanRequest::Cleanup {
        root_id: bench.root.id,
    });
    let held = bench.held().len() as i64;
    assert!(held > 0);
    let batches = bench.held_batches();
    let emptied = bench
        .engine
        .empty_holding(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    assert_eq!(
        (emptied.emptied, emptied.failed.len()),
        (held, 0),
        "{emptied:?}"
    );
    assert!(bench.held().is_empty());
    let data = DataRoot::at(bench._scratch.0.join("data")).unwrap();
    assert!(!batches.is_empty());
    for batch in &batches {
        assert!(!batch.exists());
        let name = batch.file_name().unwrap();
        assert!(
            data.sandbox_trash().join(name).is_dir(),
            "{}",
            batch.display()
        );
    }
}

/// Every keeper the step relies on: a set that keeps two pictures, one of them changed.
#[test]
fn a_copy_stays_when_any_file_kept_with_it_has_changed() {
    let Some(bench) = Bench::open("keepers-changed") else {
        return;
    };
    let mut settings = block_on(bench.engine.settings()).unwrap();
    settings.spot_variants = true;
    let update = block_on(bench.engine.update_settings(settings)).unwrap();
    if update.analyze {
        bench
            .engine
            .analyze(bench.root.id, AnalysisKind::AskedFor)
            .run(&bench.quiet())
            .unwrap();
    }
    let set = bench
        .duplicate_sets(DuplicateScope::All)
        .into_iter()
        .find(|set| {
            set.keep.len() > 1
                && set
                    .versions
                    .iter()
                    .flat_map(|version| &version.files)
                    .any(|file| !set.keep.contains(&file.id))
        })
        .expect("a set keeping two pictures and removing another file");
    let group = bench.suggestion(&set);
    let last = set
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .rfind(|file| group.keep.contains(&file.id))
        .unwrap();
    fs::write(bench.archive.join(&last.rel_path), b"something else").unwrap();
    let performed = bench
        .engine
        .perform(PlanRequest::ResolveDuplicates {
            groups: vec![group],
        })
        .run(&bench.quiet())
        .unwrap();
    assert!(bench.held().is_empty(), "{:?}", performed.applied.plan);
}

/// A keeper that is only touched, as a sync client tags a file, holds what it held: the removal
/// goes ahead.
#[cfg(unix)]
#[test]
fn a_keeper_only_touched_still_lets_its_copies_go() {
    use std::os::unix::fs::PermissionsExt as _;

    let Some(bench) = Bench::open("kept-touched") else {
        return;
    };
    let set = bench
        .duplicate_sets(DuplicateScope::All)
        .into_iter()
        .find(|set| set.kind == DuplicateKind::Exact)
        .unwrap();
    let group = bench.suggestion(&set);
    let kept = set
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .find(|file| group.keep.contains(&file.id))
        .unwrap();
    let path = bench.archive.join(&kept.rel_path);
    let mode = fs::metadata(&path).unwrap().permissions().mode();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode ^ 0o040)).unwrap();
    let going = group.remove.len();
    let plan = bench.perform(PlanRequest::ResolveDuplicates {
        groups: vec![group],
    });
    assert_eq!(plan.status, PlanStatus::Applied);
    assert_eq!(bench.held().len(), going);
}

/// Stops the work once `after` of its steps are done.
struct StopsAfter {
    after: u64,
    token: CancelToken,
}

impl Progress for StopsAfter {
    fn phase(&self, _label: &str, _total: u64) {}

    fn done(&self, done: u64) {
        if done >= self.after {
            self.token.cancel();
        }
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        Some(&self.token)
    }
}

/// Files that came back before an Undo was stopped have no catalog row until a scan: it says what
/// happened, asks for that scan, and can be pressed again to finish.
#[test]
fn a_stopped_undo_keeps_what_came_back_and_asks_for_its_scan() {
    let Some(bench) = Bench::open("stopped-undo") else {
        return;
    };
    let groups: Vec<ResolveGroup> = bench
        .duplicate_sets(DuplicateScope::All)
        .iter()
        .map(|set| bench.suggestion(set))
        .filter(|group| !group.remove.is_empty())
        .collect();
    let plan = bench.perform(PlanRequest::ResolveDuplicates { groups });
    let held = bench.held().len();
    assert!(held >= 2, "{held}");

    let undone = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&StopsAfter {
            after: 1,
            token: CancelToken::new(),
        })
        .expect("a stopped undo still reports what it did");
    assert!(!undone.complete);
    assert!(
        undone
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("Stopped")
    );
    assert_eq!(undone.follow_up.rescan, [bench.root.id]);
    assert_eq!(
        bench.held().len(),
        held - 1,
        "one came back, and stays back"
    );

    bench.follow_up(&undone.follow_up);
    let again = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&bench.quiet())
        .unwrap();
    assert!(again.complete, "{:?}", again.message);
    assert!(bench.held().is_empty());
}

/// With Spot variants off, the copy ranked first has a failed print and its twin the hardware
/// route's: the damaged bytes are still read before anything goes.
#[cfg(target_os = "macos")]
#[test]
fn with_spot_variants_off_a_damaged_twin_is_read_though_the_first_copy_has_no_print() {
    let Some(media) = support::media() else {
        return;
    };
    let scratch = Scratch::new("spot-off-twin");
    let Some((source, _, bytes)) = a_damaged_avif(&media, &scratch) else {
        return;
    };
    let archive = scratch.0.join("archive");
    fs::create_dir_all(&archive).unwrap();
    let bench = Bench::over(scratch, archive, media, false);
    let mut settings = block_on(bench.engine.settings()).unwrap();
    settings.spot_variants = false;
    block_on(bench.engine.update_settings(settings)).unwrap();
    fs::create_dir_all(bench.archive.join("twin")).unwrap();
    fs::copy(&source, bench.archive.join("photo.png")).unwrap();
    fs::write(bench.archive.join("photo.avif"), &bytes).unwrap();
    fs::write(bench.archive.join("twin/photo.avif"), &bytes).unwrap();
    bench
        .engine
        .scan(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    bench
        .engine
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();

    // The first of its copies, as ranked: its read failed, or the pass stopped before it.
    let first = bench.id("photo.avif");
    let catalog = bench.catalog();
    catalog
        .execute(
            "UPDATE files SET fingerprint = NULL, fingerprint_error = 'unread' WHERE id = ?1",
            [first],
        )
        .unwrap();
    catalog.execute("DELETE FROM file_comparisons", []).unwrap();
    let reopened = bench.reopened();
    reopened
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&bench.quiet())
        .unwrap();

    let sets = bench.page(&reopened, DuplicateScope::Variants).sets;
    let all = bench.page(&reopened, DuplicateScope::All).sets;
    let found: Vec<&DuplicateSet> = sets.iter().chain(&all).collect();
    assert!(!found.is_empty());
    let png = bench.id("photo.png");
    for set in found {
        assert!(
            set.keep.contains(&png),
            "keeps {:?} for {:?}",
            set.keep,
            set.keep_reason
        );
    }
    let unread: i64 = catalog
        .query_row(
            "SELECT COUNT(*) FROM file_comparisons WHERE variant = 2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(unread > 0, "the answer could be stored");
}

/// A scan has caught the catalog up by the time the owner acts on a page read before it, so the
/// keeper check at apply time sees nothing wrong: what they decided about is not there any more.
#[test]
fn a_decision_on_a_page_gone_stale_moves_nothing() {
    type Pick = fn(&ResolveGroup) -> FileId;
    let picks: [(&str, Pick); 2] = [
        ("the file kept", |group| group.keep[0]),
        ("a file going", |group| group.remove[0]),
    ];
    for (name, pick) in picks {
        let Some(bench) = Bench::open("stale-page") else {
            return;
        };
        let set = bench
            .duplicate_sets(DuplicateScope::All)
            .into_iter()
            .find(|set| set.kind == DuplicateKind::Exact)
            .unwrap();
        let group = bench.suggestion(&set);
        let id = pick(&group);
        let file = set
            .versions
            .iter()
            .flat_map(|version| &version.files)
            .find(|file| file.id == id)
            .unwrap();
        fs::write(bench.archive.join(&file.rel_path), b"something else").unwrap();
        bench
            .engine
            .scan(bench.root.id)
            .run(&bench.quiet())
            .unwrap();

        let refused = bench
            .engine
            .perform(PlanRequest::ResolveDuplicates {
                groups: vec![group],
            })
            .run(&bench.quiet())
            .err()
            .unwrap_or_else(|| panic!("{name}: the decision went ahead"));
        assert!(refused.to_string().contains("changed since"), "{refused}");
        assert!(bench.held().is_empty(), "{name}");
    }
}

/// Of several decisions, only those about what changed are left out, and the owner is told.
#[test]
fn only_the_decision_about_what_changed_is_left_out() {
    let Some(bench) = Bench::open("stale-group") else {
        return;
    };
    let sets = bench.duplicate_sets(DuplicateScope::All);
    let exact = sets
        .iter()
        .find(|set| set.kind == DuplicateKind::Exact)
        .unwrap();
    let other = sets
        .iter()
        .find(|set| set.kind != DuplicateKind::Exact && !bench.suggestion(set).remove.is_empty())
        .unwrap();
    let groups = vec![bench.suggestion(exact), bench.suggestion(other)];
    let kept = exact
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .find(|file| exact.keep.contains(&file.id))
        .unwrap();
    fs::write(bench.archive.join(&kept.rel_path), b"something else").unwrap();
    bench
        .engine
        .scan(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    let going = groups[1].remove.len() as i64;
    let request = PlanRequest::ResolveDuplicates { groups };
    let preview = block_on(bench.engine.preview_plan(request.clone())).unwrap();
    assert_eq!(
        preview.warnings,
        ["1 set has changed since you saw it and stays as it is. Look at it again."]
    );
    let plan = bench.perform(request);
    assert_eq!(plan.held.files, going);
}

/// A plan quit partway with nothing done: recovery leaves no mark behind that no Undo can reach.
#[test]
fn a_plan_quit_with_nothing_done_leaves_no_mark() {
    let Some(bench) = Bench::open("quit-no-mark") else {
        return;
    };
    let set = bench
        .duplicate_sets(DuplicateScope::All)
        .into_iter()
        .find(|set| set.keep.len() > 1)
        .expect("a set keeping two pictures");
    let group = bench.suggestion(&set);
    let preview = block_on(bench.engine.preview_plan(PlanRequest::ResolveDuplicates {
        groups: vec![group],
    }))
    .unwrap();
    let catalog = bench.catalog();
    let marks = |catalog: &rusqlite::Connection| -> i64 {
        catalog
            .query_row(
                "SELECT COUNT(*) FROM duplicate_dismissals WHERE plan_id = ?1",
                [preview.plan_id],
                |row| row.get(0),
            )
            .unwrap()
    };
    assert_eq!(marks(&catalog), 1);
    catalog
        .execute(
            "UPDATE plans SET status = 'applying' WHERE id = ?1",
            [preview.plan_id],
        )
        .unwrap();
    let _opened = bench.reopened();
    assert_eq!(marks(&catalog), 0);
    let status: String = catalog
        .query_row(
            "SELECT status FROM plans WHERE id = ?1",
            [preview.plan_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled");
}

/// Same size, same date, other bytes, and a scan since: only the hash can tell, or the change time
/// without one. It must not refuse a file with no hash, as most stills are, nor one whose hash has
/// only just arrived.
#[test]
fn a_decision_goes_by_the_hash_the_page_showed() {
    let exact_set = |bench: &Bench| {
        bench
            .duplicate_sets(DuplicateScope::All)
            .into_iter()
            .find(|set| set.kind == DuplicateKind::Exact)
            .unwrap()
    };
    let decide = |bench: &Bench, group: ResolveGroup| {
        bench
            .engine
            .perform(PlanRequest::ResolveDuplicates {
                groups: vec![group],
            })
            .run(&bench.quiet())
    };

    // The bytes differ, with the same size and date.
    let Some(bench) = Bench::open("seen-hash-differs") else {
        return;
    };
    let set = exact_set(&bench);
    let group = bench.suggestion(&set);
    bench
        .catalog()
        .execute(
            "UPDATE files SET sha256 = 'other bytes' WHERE id = ?1",
            [group.keep[0]],
        )
        .unwrap();
    let Err(refused) = decide(&bench, group) else {
        panic!("it went ahead");
    };
    assert!(refused.to_string().contains("changed since"), "{refused}");
    assert!(bench.held().is_empty());

    // A scan saw it change, and has not read it again.
    let Some(bench) = Bench::open("seen-hash-gone") else {
        return;
    };
    let set = exact_set(&bench);
    let group = bench.suggestion(&set);
    bench
        .catalog()
        .execute(
            "UPDATE files SET sha256 = NULL WHERE id = ?1",
            [group.keep[0]],
        )
        .unwrap();
    assert!(decide(&bench, group).is_err());
    assert!(bench.held().is_empty());

    // None then, none now, or one only now: nothing says the file changed.
    let Some(bench) = Bench::open("seen-no-hash") else {
        return;
    };
    let set = exact_set(&bench);
    let mut group = bench.suggestion(&set);
    let going = group.remove.len();
    for seen in &mut group.seen {
        seen.sha256 = None;
    }
    let done = decide(&bench, group).unwrap();
    assert_eq!(done.applied.plan.done, going as i64);

    // No hash on the page, and the file replaced by one of the same size and date. A scan has
    // caught the catalog up, so its own answers agree with the file, but not with the page.
    let Some(bench) = Bench::open("seen-replaced") else {
        return;
    };
    let set = exact_set(&bench);
    let mut group = bench.suggestion(&set);
    for seen in &mut group.seen {
        seen.sha256 = None;
    }
    let path = set
        .versions
        .iter()
        .flat_map(|version| &version.files)
        .find(|file| file.id == group.keep[0])
        .map(|file| PathBuf::from(&file.abs_path))
        .unwrap();
    let written = fs::metadata(&path).unwrap();
    let mut bytes = fs::read(&path).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0xff;
    let replacement = path.with_extension("replacement");
    fs::write(&replacement, &bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_modified(written.modified().unwrap())
        .unwrap();
    // The clock the file system stamps its ctime with moves in whole milliseconds at least.
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::rename(&replacement, &path).unwrap();
    bench
        .engine
        .scan(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    let Err(refused) = decide(&bench, group) else {
        panic!("it went ahead");
    };
    assert!(refused.to_string().contains("changed since"), "{refused}");
    assert!(bench.held().is_empty());
}

/// A stopped change skipped files as stale before it stopped, or left the catalog behind: its
/// scan still comes, as after a stopped Undo.
#[test]
fn a_stopped_change_still_asks_for_its_scan() {
    let Some(bench) = Bench::open("stopped-apply") else {
        return;
    };
    let groups: Vec<ResolveGroup> = bench
        .duplicate_sets(DuplicateScope::All)
        .iter()
        .map(|set| bench.suggestion(set))
        .filter(|group| !group.remove.is_empty())
        .collect();
    let performed = bench
        .engine
        .perform(PlanRequest::ResolveDuplicates { groups })
        .run(&StopsAfter {
            after: 1,
            token: CancelToken::new(),
        })
        .unwrap();
    assert_eq!(performed.applied.plan.status, PlanStatus::Cancelled);
    assert_eq!(performed.applied.follow_up.rescan, [bench.root.id]);
}

/// With libvips gone every print fails, every set of stills then counts as variants, and variants
/// are not offered for prints: the failures must go first, or nothing would ever ask again.
#[test]
fn prints_that_failed_for_want_of_libvips_are_made_when_it_returns() {
    let Some(bench) = Bench::open("prints-no-libvips") else {
        return;
    };
    let catalog = bench.catalog();
    catalog.execute("DELETE FROM file_details", []).unwrap();
    catalog.execute("DELETE FROM file_comparisons", []).unwrap();
    let without = without_libvips(&bench);
    without
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&Quiet::new())
        .unwrap();
    drop(without);
    let failed = "SELECT COUNT(*) FROM file_details WHERE error IS NOT NULL";
    let count = |sql: &str| -> i64 { catalog.query_row(sql, [], |row| row.get(0)).unwrap() };
    assert!(count(failed) > 0);

    let again = bench.reopened();
    again
        .analyze(bench.root.id, AnalysisKind::AskedFor)
        .run(&Quiet::new())
        .unwrap();
    assert_eq!(count(failed), 0);
    assert!(count("SELECT COUNT(*) FROM file_details WHERE print IS NOT NULL") > 0);
    assert!(!block_on(again.analysis_due(bench.root.id)).unwrap());
}

/// Converting one of two variants must not make the set offer to remove the other.
#[test]
fn converting_a_variant_holds_its_set_until_it_has_a_print() {
    let Some(bench) = Bench::open("converted-variant") else {
        return;
    };
    let (a, b) = ("alt/outfit-a.png", "alt/outfit-b.png");
    let (a_id, b_id) = (bench.id(a), bench.id(b));
    let page = bench.page(&bench.engine, DuplicateScope::Variants);
    let set = page
        .sets
        .iter()
        .find(|set| ids_of(set).contains(&a_id))
        .expect("a set of variants");
    assert_eq!(set.keep.len(), 2);
    let performed = bench
        .engine
        .perform(PlanRequest::Optimize {
            root_id: bench.root.id,
            categories: vec![OptimizeCategory::StillToAvif],
            file_ids: Some(vec![b_id]),
        })
        .run(&bench.quiet())
        .unwrap();

    // Before the analysis the change asks for: in no queue, offering nothing.
    let page = bench.page(&bench.engine, DuplicateScope::All);
    assert!(page.sets.iter().all(|set| !ids_of(set).contains(&a_id)));
    assert!(page.counts.checking > 0);

    bench.follow_up(&performed.applied.follow_up);
    let page = bench.page(&bench.engine, DuplicateScope::Variants);
    let set = page
        .sets
        .iter()
        .find(|set| ids_of(set).contains(&a_id))
        .expect("variants again, once it has a print");
    assert_eq!(set.keep.len(), 2);
    assert!(bench.archive.join(a).is_file());
}

/// A Shrink result beats the larger file only while it is that file's own re-encode and the
/// original is still in holding; otherwise the full-quality copy is the one to keep.
#[test]
fn a_re_encode_is_preferred_only_while_its_original_is_held() {
    let Some(bench) = shrink_bench("re-encode-rule") else {
        return;
    };
    let (kept, other) = ("clips/busy.mp4", "copies/busy.mp4");
    let plan = bench.perform(PlanRequest::Reencode {
        file_ids: vec![bench.id(kept)],
        codec: VideoCodecChoice::Av1,
        quality: VideoQuality::High,
    });
    assert_eq!(bench.steps(plan.id)[0].status, StepStatus::Done);
    let set = bench.set_with(other);
    let name = bench.name_of(&set, set.keep[0]);
    assert_eq!(name, kept, "its source is held, so the re-encode is kept");
    assert_eq!(set.keep_reason, KeepReason::AlreadyReencoded);

    // The owner empties holding: the other file is now the last at full quality.
    bench
        .engine
        .empty_holding(bench.root.id)
        .run(&bench.quiet())
        .unwrap();
    let set = bench.set_with(other);
    let name = bench.name_of(&set, set.keep[0]);
    assert_eq!(
        name, other,
        "the larger file stays once the original has gone"
    );
    assert_eq!(set.keep_reason, KeepReason::LargerFile);
}

/// A bench over Shrink's clips, with `copies/busy.mp4` an identical copy of `clips/busy.mp4`.
fn shrink_bench(label: &str) -> Option<Bench> {
    let media = support::media()?;
    oriel_test_archive::media_tools()?;
    let scratch = Scratch::new(label);
    let archive = scratch.0.join("shrink-archive");
    assert!(oriel_test_archive::build_shrink_archive(&archive));
    fs::remove_file(archive.join("tiny.mp4")).ok();
    fs::create_dir_all(archive.join("copies")).unwrap();
    fs::copy(
        archive.join("clips/busy.mp4"),
        archive.join("copies/busy.mp4"),
    )
    .unwrap();
    Some(Bench::over(scratch, archive, media, true))
}

/// A source another program changes while it is converted: its result is of bytes no longer there,
/// so it must neither replace it nor be recorded as what those bytes convert to.
#[cfg(unix)]
#[test]
fn a_source_changed_during_its_conversion_is_left_alone() {
    use std::os::unix::fs::PermissionsExt as _;

    let Some(bench) = shrink_bench("changed-during") else {
        return;
    };
    let source = bench.archive.join("clips/busy.mp4");
    let flag = bench._scratch.0.join("change-it-now");
    let shim = bench._scratch.0.join("ffmpeg-that-changes-its-source");
    let ffmpeg = bench.media.ffmpeg.clone().unwrap();
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \"$*\" in *-c:v*) if [ -f '{flag}' ]; then rm '{flag}'; printf x >> '{source}'; fi;; esac\nexec '{ffmpeg}' \"$@\"\n",
            flag = flag.display(),
            source = source.display(),
            ffmpeg = ffmpeg.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    let media = Media {
        ffmpeg: Some(shim),
        ..bench.media.clone()
    };
    let data = DataRoot::at(bench._scratch.0.join("data")).unwrap();
    let engine = block_on(TidyEngine::open_with(data, bench.catalog_path(), media)).unwrap();
    fs::write(&flag, "").unwrap();
    let id = bench.id("clips/busy.mp4");
    let performed = engine
        .perform(PlanRequest::Reencode {
            file_ids: vec![id],
            codec: VideoCodecChoice::Av1,
            quality: VideoQuality::High,
        })
        .run(&bench.quiet())
        .unwrap();
    assert!(!flag.exists(), "the conversion never ran");
    let steps = bench.steps(performed.preview.plan_id);
    assert_eq!(steps[0].status, StepStatus::Skipped, "{:?}", steps[0]);
    assert!(source.is_file());
    assert!(bench.held().is_empty());
    let recorded: i64 = bench
        .catalog()
        .query_row(
            "SELECT COUNT(*) FROM plan_steps WHERE output_sha256 IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 0, "the wrong result would be taken by its copies");
}

/// A step that cannot be undone leaves the plan as it was: History must not say undone.
#[test]
fn a_plan_whose_undo_failed_is_not_called_undone() {
    use std::io::Write as _;

    let Some(bench) = shrink_bench("undo-failed") else {
        return;
    };
    let plan = bench.perform(PlanRequest::Reencode {
        file_ids: vec![bench.id("clips/busy.mp4")],
        codec: VideoCodecChoice::Av1,
        quality: VideoQuality::High,
    });
    let output = bench.archive.join("clips/busy.mp4");
    let converted = fs::read(&output).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&output)
        .unwrap()
        .write_all(b"changed since")
        .unwrap();
    let undone = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&bench.quiet())
        .unwrap();
    assert!(!undone.complete);
    assert!(
        undone
            .message
            .clone()
            .unwrap()
            .contains("could not be put back")
    );
    let history = block_on(bench.engine.list_plans(PlanListRequest {
        root_id: Some(bench.root.id),
        offset: 0,
        limit: 20,
    }))
    .unwrap();
    let listed = history.iter().find(|listed| listed.id == plan.id).unwrap();
    assert_ne!(listed.status, PlanStatus::Undone);
    assert!(listed.can_undo());
    assert_eq!(bench.held().len(), 1, "the original stays in holding");
    let steps = bench.steps(plan.id);
    let told = steps[0].message.clone().unwrap_or_default();
    assert!(told.starts_with("Undo failed"), "{told}");

    // A rescan comes with the undo that did not finish, for the steps that did.
    assert_eq!(undone.follow_up.rescan, [bench.root.id]);

    // Put right, the undo goes through, and what it said about the first try is gone.
    fs::write(&output, &converted).unwrap();
    let again = bench
        .engine
        .undo([plan.id].to_vec())
        .run(&bench.quiet())
        .unwrap();
    assert!(again.complete, "{:?}", again.message);
    let steps = bench.steps(plan.id);
    assert!(
        !steps[0]
            .message
            .as_deref()
            .is_some_and(|message| message.starts_with("Undo failed")),
        "{:?}",
        steps[0].message
    );
}
