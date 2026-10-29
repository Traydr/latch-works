//! The planner, from glazier-core's `plans/planner.ts`: a request becomes concrete steps against
//! the catalog as it is now, saved as a draft plan the owner can review. Nothing here touches the
//! disk; the executor does, and re-checks each file first.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::bail;
use indexmap::IndexMap;
use oriel_core_domain::is_supported_media_file;
use oriel_core_format::{
    AnimatedImageMimeType, ArchiveVideoCodec, ArchiveVideoPlan, AudioTrackPlan, VideoTrackPlan,
    plan_strip_audio, plan_video_reencode, replace_file_extension,
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::catalog::files::{get_file_records, js_trim};
use crate::catalog::rows::{FileRecord, to_absolute_path};
use crate::catalog::{now_ms, transaction};
use crate::contract::{
    ActionCount, FileId, FileKind, LockstepCounts, OptimizeCategory, PlanId, PlanKind, PlanPreview,
    PlanRequest, PlanStepAction, ResolveGroup, Root, RootId, Settings, VideoCodecChoice,
    VideoQuality, shrink_batch,
};
use crate::duplicates::{add_dismissal, removals_for};
use crate::optimize::candidates::video_source_of;
use crate::optimize::shrink::find_shrink_candidates;
use crate::optimize::{CandidateHolds, extension_fixes, find_optimize_candidates};
use crate::scan::preferred_extension;

/// What a step does, stored as JSON beside it in glazier-core's form: the `kind` matches the
/// step's `action` column.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StepSpec {
    Hold {
        reason: String,
    },
    Move,
    Rename,
    ConvertAvif,
    ConvertAnimation {
        mime_type: AnimatedImageMimeType,
    },
    ConvertVideo {
        video: VideoTrackPlan,
        audio: AudioTrackPlan,
        quality: VideoQuality,
        /// Re-encodes must save space to be kept; container moves only need to succeed.
        require_smaller: bool,
    },
    RemoveFolder,
}

impl StepSpec {
    pub fn action(&self) -> PlanStepAction {
        match self {
            Self::Hold { .. } => PlanStepAction::Hold,
            Self::Move => PlanStepAction::Move,
            Self::Rename => PlanStepAction::Rename,
            Self::ConvertAvif => PlanStepAction::ConvertAvif,
            Self::ConvertAnimation { .. } => PlanStepAction::ConvertAnimation,
            Self::ConvertVideo { .. } => PlanStepAction::ConvertVideo,
            Self::RemoveFolder => PlanStepAction::RemoveFolder,
        }
    }
}

/// What the executor re-checks a file against before touching it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Expected {
    pub size: i64,
    pub mtime_ms: f64,
    pub ctime_ms: f64,
}

/// A step before it is stored.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftStep {
    pub spec: StepSpec,
    pub root_id: RootId,
    pub from_rel: String,
    /// The absolute path a move, rename or conversion writes to.
    pub to_abs: Option<String>,
    pub expected: Expected,
}

/// A request the planner refuses, with the reason the owner sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanRequestError(pub String);

impl std::fmt::Display for PlanRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlanRequestError {}

/// The message a plan with no steps fails with; Tidy up skips such a step rather than report it.
pub const NOTHING_TO_DO: &str = "There is nothing to do for this selection.";

/// What the planner reads besides the catalog.
#[derive(Clone, Debug)]
pub struct PlannerContext {
    pub roots: Vec<Root>,
    pub settings: Settings,
    /// Files Convert and Clean up leave alone for now, worked out by the engine before planning.
    pub candidate_holds: CandidateHolds,
}

/// A request expanded into steps, with what the owner should know before applying it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanDraft {
    pub steps: Vec<DraftStep>,
    pub warnings: Vec<String>,
    /// What the plan is about, counted: duplicate sets, empty folders, or else its steps.
    pub count: i64,
    /// The files each group that keeps several remembers as not duplicates of each other.
    pub dismissals: Vec<Vec<FileId>>,
}

fn file_step(record: &FileRecord, spec: StepSpec, to_abs: Option<PathBuf>) -> DraftStep {
    DraftStep {
        spec,
        root_id: record.root_id,
        from_rel: record.rel_path.clone(),
        to_abs: to_abs.map(|path| path.to_string_lossy().into_owned()),
        expected: Expected {
            size: record.size,
            mtime_ms: record.mtime_ms,
            ctime_ms: record.ctime_ms,
        },
    }
}

fn beside_original(record: &FileRecord, name: &str) -> PathBuf {
    let original = to_absolute_path(&record.root_path, &record.rel_path);
    original.parent().unwrap_or(Path::new("")).join(name)
}

/// The ids once each, in the order first given.
fn unique_ids(ids: impl IntoIterator<Item = FileId>) -> Vec<FileId> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn load_records(connection: &Connection, ids: &[FileId]) -> anyhow::Result<Vec<FileRecord>> {
    let unique = unique_ids(ids.iter().copied());
    let records = get_file_records(connection, &unique)?;
    if records.len() != unique.len() {
        bail!(PlanRequestError(
            "Some files are no longer in the catalog. Rescan and try again.".into()
        ));
    }
    Ok(records)
}

enum VideoStep {
    Step(DraftStep),
    Skip,
}

fn video_step(
    record: &FileRecord,
    plan: ArchiveVideoPlan,
    quality: VideoQuality,
    require_smaller: bool,
) -> VideoStep {
    let ArchiveVideoPlan::ConvertMp4 {
        file_name,
        video,
        audio,
    } = plan
    else {
        return VideoStep::Skip;
    };
    VideoStep::Step(file_step(
        record,
        StepSpec::ConvertVideo {
            video,
            audio,
            quality,
            require_smaller,
        },
        Some(beside_original(record, &file_name)),
    ))
}

/// Hold steps for duplicate decisions, and how many groups changed anything. A file some group
/// keeps, or that shares its bytes on disk with a kept file, is never removed.
fn draft_resolution(
    connection: &Connection,
    groups: &[ResolveGroup],
    draft: &mut PlanDraft,
) -> anyhow::Result<i64> {
    let all: Vec<FileId> = groups
        .iter()
        .flat_map(|group| group.keep.iter().chain(&group.remove).copied())
        .collect();
    let by_id: HashMap<FileId, FileRecord> = load_records(connection, &all)?
        .into_iter()
        .map(|record| (record.id, record))
        .collect();
    let kept: HashSet<FileId> = groups
        .iter()
        .flat_map(|group| group.keep.iter().copied())
        .collect();
    let mut removed = HashSet::new();
    let mut resolved = 0;

    for group in groups {
        let keepers: Vec<&FileRecord> = group.keep.iter().filter_map(|id| by_id.get(id)).collect();
        let Some(keeper) = keepers.first().copied() else {
            bail!(PlanRequestError(
                "Every duplicate group must keep a file and remove others.".into()
            ));
        };
        if group.remove.iter().any(|id| group.keep.contains(id)) {
            bail!(PlanRequestError(
                "Every duplicate group must keep a file and remove others.".into()
            ));
        }
        let members: Vec<FileRecord> = keepers
            .iter()
            .map(|record| (*record).clone())
            .chain(group.remove.iter().filter_map(|id| by_id.get(id).cloned()))
            .collect();
        let mut changed = false;
        for record in removals_for(&members, &group.keep) {
            if removed.contains(&record.id) || kept.contains(&record.id) {
                continue;
            }
            removed.insert(record.id);
            changed = true;
            draft.steps.push(file_step(
                record,
                StepSpec::Hold {
                    reason: format!("Duplicate of {}", keeper.rel_path),
                },
                None,
            ));
        }
        let kept_ids = unique_ids(group.keep.iter().copied());
        if kept_ids.len() > 1 {
            draft.dismissals.push(kept_ids);
            changed = true;
        }
        if changed {
            resolved += 1;
        }
    }
    // Keepers already favour preferred folders, so removing a copy from one is a deliberate pick
    // (or every copy is in one) and is not warned about.
    Ok(resolved)
}

/// Appends a step removing each of a root's empty folders, deepest first; returns how many.
fn draft_folder_removals(
    connection: &Connection,
    root_id: RootId,
    steps: &mut Vec<DraftStep>,
) -> anyhow::Result<i64> {
    let mut statement = connection.prepare_cached(
        "SELECT rel_path FROM empty_folders WHERE root_id = ?1 ORDER BY length(rel_path) DESC",
    )?;
    let folders: Vec<String> = statement
        .query_map([root_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for folder in &folders {
        steps.push(DraftStep {
            spec: StepSpec::RemoveFolder,
            root_id,
            from_rel: folder.clone(),
            to_abs: None,
            expected: Expected::default(),
        });
    }
    Ok(folders.len() as i64)
}

fn junk_records(
    connection: &Connection,
    root_id: RootId,
    dir: Option<&str>,
) -> anyhow::Result<Vec<FileRecord>> {
    let ids: Vec<FileId> = match dir {
        None => {
            let mut statement = connection.prepare_cached(
                "SELECT f.id FROM files f WHERE f.root_id = ?1 AND f.is_junk = 1",
            )?;
            statement
                .query_map([root_id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        }
        Some(dir) => {
            let mut statement = connection.prepare_cached(
                "SELECT f.id FROM files f WHERE f.root_id = ?1 AND f.is_junk = 1 AND f.dir = ?2",
            )?;
            statement
                .query_map(params![root_id, dir], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        }
    };
    load_records(connection, &ids)
}

fn junk_hold(record: &FileRecord) -> DraftStep {
    file_step(
        record,
        StepSpec::Hold {
            reason: "System junk".into(),
        },
        None,
    )
}

/// glazier-core's `isPlainFileName`: no path separators, no NUL, not `.` or `..`, and at most
/// 255 UTF-16 code units.
fn is_plain_file_name(name: &str) -> bool {
    name != "."
        && name != ".."
        && !name.contains(['\\', '/', '\0'])
        && name.encode_utf16().count() <= 255
}

/// Whether `target` is `root` or inside it, as glazier-core's `isWithin` decides through
/// `path.relative` (which also counts a first component starting with `..` as outside).
pub fn is_within(target: &Path, root: &Path) -> bool {
    match target.strip_prefix(root) {
        Ok(relative) => {
            let text = relative.to_string_lossy();
            text.is_empty() || !text.starts_with("..")
        }
        Err(_) => false,
    }
}

fn require_files(ids: &[FileId]) -> anyhow::Result<()> {
    if ids.is_empty() {
        bail!(PlanRequestError("The request names no files.".into()));
    }
    Ok(())
}

/// Expands a request into concrete steps against the current catalog. Nothing touches disk.
pub fn draft_steps(
    connection: &Connection,
    context: &PlannerContext,
    request: &PlanRequest,
) -> anyhow::Result<PlanDraft> {
    let mut draft = PlanDraft::default();
    let mut count = None;

    match request {
        PlanRequest::Hold { file_ids } => {
            require_files(file_ids)?;
            for record in load_records(connection, file_ids)? {
                draft.steps.push(file_step(
                    &record,
                    StepSpec::Hold {
                        reason: "Removed".into(),
                    },
                    None,
                ));
            }
        }
        PlanRequest::Move {
            file_ids,
            target_dir,
        } => {
            require_files(file_ids)?;
            let target = std::path::absolute(target_dir)?;
            let in_root = context
                .roots
                .iter()
                .any(|root| is_within(&target, Path::new(&root.path)));
            if !in_root {
                draft.warnings.push(
                    "The target folder is outside every root, so moved files leave Glazier's \
                     catalog."
                        .into(),
                );
            }
            for record in load_records(connection, file_ids)? {
                draft.steps.push(file_step(
                    &record,
                    StepSpec::Move,
                    Some(target.join(&record.name)),
                ));
            }
        }
        PlanRequest::Rename { renames } => {
            let ids: Vec<FileId> = renames.iter().map(|rename| rename.file_id).collect();
            require_files(&ids)?;
            let by_id: HashMap<FileId, FileRecord> = load_records(connection, &ids)?
                .into_iter()
                .map(|record| (record.id, record))
                .collect();
            for rename in renames {
                let name = js_trim(&rename.name);
                let Some(record) = by_id.get(&rename.file_id) else {
                    continue;
                };
                if name == record.name {
                    continue;
                }
                if !is_plain_file_name(name) {
                    bail!(PlanRequestError(format!(
                        "\"{name}\" is not a usable file name."
                    )));
                }
                draft.steps.push(file_step(
                    record,
                    StepSpec::Rename,
                    Some(beside_original(record, name)),
                ));
            }
        }
        PlanRequest::FixExtension { file_ids } => {
            require_files(file_ids)?;
            for record in load_records(connection, file_ids)? {
                if let Some(extension) = record.format.and_then(preferred_extension)
                    && record.ext_mismatch
                {
                    let name = replace_file_extension(&record.name, extension);
                    draft.steps.push(file_step(
                        &record,
                        StepSpec::Rename,
                        Some(beside_original(&record, &name)),
                    ));
                }
            }
        }
        PlanRequest::Optimize {
            root_id,
            categories,
            file_ids,
        } => {
            if categories.is_empty() {
                bail!(PlanRequestError("The request names no categories.".into()));
            }
            let wanted: Option<HashSet<FileId>> =
                file_ids.as_ref().map(|ids| ids.iter().copied().collect());
            let scan = find_optimize_candidates(connection, *root_id, &context.candidate_holds)?;
            for candidate in &scan.candidates {
                if !categories.contains(&candidate.category) {
                    continue;
                }
                if wanted
                    .as_ref()
                    .is_some_and(|wanted| !wanted.contains(&candidate.record.id))
                {
                    continue;
                }
                let target = Some(beside_original(&candidate.record, &candidate.target_name));
                let spec = match candidate.category {
                    OptimizeCategory::StillToAvif => StepSpec::ConvertAvif,
                    OptimizeCategory::AnimationToMp4 => StepSpec::ConvertAnimation {
                        mime_type: match candidate.mime_type {
                            Some("image/webp") => AnimatedImageMimeType::Webp,
                            Some("image/png") => AnimatedImageMimeType::Png,
                            _ => AnimatedImageMimeType::Gif,
                        },
                    },
                    OptimizeCategory::VideoRemux | OptimizeCategory::VideoConvert => {
                        let Some((video, audio)) = candidate.tracks else {
                            continue;
                        };
                        StepSpec::ConvertVideo {
                            video,
                            audio,
                            quality: context.settings.reencode_quality,
                            require_smaller: false,
                        }
                    }
                    OptimizeCategory::RenameAvif | OptimizeCategory::RenameMp4 => StepSpec::Rename,
                };
                draft.steps.push(file_step(&candidate.record, spec, target));
            }
        }
        PlanRequest::Reencode { file_ids, .. } | PlanRequest::StripAudio { file_ids } => {
            require_files(file_ids)?;
            let mut skipped = 0;
            for record in load_records(connection, file_ids)? {
                let source = (record.kind == FileKind::Video)
                    .then(|| video_source_of(&record))
                    .flatten();
                let Some(source) = source else {
                    skipped += 1;
                    continue;
                };
                let step = match request {
                    PlanRequest::Reencode { codec, quality, .. } => {
                        let codec = match codec {
                            VideoCodecChoice::Avc => ArchiveVideoCodec::Avc,
                            VideoCodecChoice::Hevc => ArchiveVideoCodec::Hevc,
                            VideoCodecChoice::Av1 => ArchiveVideoCodec::Av1,
                        };
                        video_step(&record, plan_video_reencode(&source, codec), *quality, true)
                    }
                    _ => video_step(
                        &record,
                        plan_strip_audio(&source),
                        context.settings.reencode_quality,
                        false,
                    ),
                };
                match step {
                    VideoStep::Step(step) => draft.steps.push(step),
                    VideoStep::Skip => skipped += 1,
                }
            }
            if skipped > 0 {
                draft.warnings.push(format!(
                    "{skipped} selected files are not videos Glazier can rewrite and are left out."
                ));
            }
        }
        PlanRequest::ResolveDuplicates { groups } => {
            if groups.is_empty()
                || groups
                    .iter()
                    .any(|group| group.keep.is_empty() || group.remove.is_empty())
            {
                bail!(PlanRequestError(
                    "Every duplicate group must keep a file and remove others.".into()
                ));
            }
            count = Some(draft_resolution(connection, groups, &mut draft)?);
        }
        PlanRequest::CleanJunk { root_id } => {
            for record in junk_records(connection, *root_id, None)? {
                draft.steps.push(junk_hold(&record));
            }
        }
        PlanRequest::RemoveEmptyFolders { root_id } => {
            let mut folders = Vec::new();
            count = Some(draft_folder_removals(connection, *root_id, &mut folders)?);
            for folder in folders {
                // A folder holding only junk such as `._` files counts as empty; its junk goes
                // first.
                for record in junk_records(connection, *root_id, Some(&folder.from_rel))? {
                    draft.steps.push(junk_hold(&record));
                }
                draft.steps.push(folder);
            }
        }
        PlanRequest::ShrinkVideos {
            root_id,
            limit_bytes,
        } => {
            let scan = find_shrink_candidates(connection, *root_id, &context.candidate_holds)?;
            let items: Vec<_> = scan.candidates.iter().map(|c| c.item.clone()).collect();
            let batch = shrink_batch(&items, *limit_bytes).len();
            // Most bytes saved first, so a run stopped partway has done the best of its batch.
            for candidate in &scan.candidates[..batch] {
                let Some(source) = video_source_of(&candidate.record) else {
                    continue;
                };
                if let VideoStep::Step(step) = video_step(
                    &candidate.record,
                    plan_video_reencode(&source, ArchiveVideoCodec::Av1),
                    context.settings.reencode_quality,
                    true,
                ) {
                    draft.steps.push(step);
                }
            }
        }
        PlanRequest::Cleanup { root_id } => {
            let scan = find_optimize_candidates(connection, *root_id, &context.candidate_holds)?;
            // Renames and junk first, so folders that held only junk are empty when their turn
            // comes.
            for (record, name) in extension_fixes(connection, *root_id, &scan.candidates)? {
                draft.steps.push(file_step(
                    &record,
                    StepSpec::Rename,
                    Some(beside_original(&record, &name)),
                ));
            }
            for record in junk_records(connection, *root_id, None)? {
                draft.steps.push(junk_hold(&record));
            }
            draft_folder_removals(connection, *root_id, &mut draft.steps)?;
        }
    }

    draft.count = count.unwrap_or(draft.steps.len() as i64);
    Ok(draft)
}

/// Whether a step puts a file in holding: a hold outright, a conversion the original it replaces.
fn moves_to_holding(action: PlanStepAction) -> bool {
    matches!(
        action,
        PlanStepAction::Hold
            | PlanStepAction::ConvertAvif
            | PlanStepAction::ConvertAnimation
            | PlanStepAction::ConvertVideo
    )
}

/// Saves a draft plan and its steps, and returns the preview the owner reviews before applying.
pub fn save_plan(
    connection: &mut Connection,
    context: &PlannerContext,
    kind: PlanKind,
    draft: &PlanDraft,
) -> anyhow::Result<PlanPreview> {
    if draft.steps.is_empty() && draft.dismissals.is_empty() {
        bail!(PlanRequestError(NOTHING_TO_DO.into()));
    }
    let plan_id = transaction(connection, |transaction| {
        transaction.execute(
            "INSERT INTO plans (kind, created_at, status, count) VALUES (?1, ?2, 'draft', ?3)",
            params![kind.as_str(), now_ms(), draft.count],
        )?;
        let id = transaction.last_insert_rowid();
        let mut insert = transaction.prepare_cached(
            "INSERT INTO plan_steps (plan_id, action, root_id, from_rel, to_abs, spec,
          expected_size, expected_mtime_ms, expected_ctime_ms, bytes_before)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7)",
        )?;
        for step in &draft.steps {
            insert.execute(params![
                id,
                step.spec.action().as_str(),
                step.root_id,
                step.from_rel,
                step.to_abs,
                serde_json::to_string(&step.spec)?,
                step.expected.size,
                step.expected.mtime_ms,
                step.expected.ctime_ms,
            ])?;
        }
        for file_ids in &draft.dismissals {
            add_dismissal(transaction, file_ids, Some(id))?;
        }
        Ok(id)
    })?;
    Ok(preview_of(context, plan_id, kind, draft))
}

fn preview_of(
    context: &PlannerContext,
    plan_id: PlanId,
    kind: PlanKind,
    draft: &PlanDraft,
) -> PlanPreview {
    let mut counts: IndexMap<PlanStepAction, i64> = IndexMap::new();
    let mut bytes_to_holding = 0;
    let mut bytes_touched = 0;
    let mut lockstep = LockstepCounts::default();
    for step in &draft.steps {
        let action = step.spec.action();
        *counts.entry(action).or_default() += 1;
        bytes_touched += step.expected.size;
        if moves_to_holding(action) {
            bytes_to_holding += step.expected.size;
        }
        if action == PlanStepAction::RemoveFolder {
            continue;
        }
        // Sync only syncs media; junk and other files never reach Pane View.
        if is_supported_media_file(&step.from_rel) {
            lockstep.removed_paths += 1;
        }
        if let Some(to) = &step.to_abs
            && is_supported_media_file(to)
            && context
                .roots
                .iter()
                .any(|root| is_within(Path::new(to), Path::new(&root.path)))
        {
            lockstep.added_paths += 1;
        }
    }
    PlanPreview {
        plan_id,
        kind,
        steps: draft.steps.len() as i64,
        by_action: counts
            .into_iter()
            .map(|(action, steps)| ActionCount { action, steps })
            .collect(),
        bytes_to_holding,
        bytes_touched,
        lockstep,
        warnings: draft.warnings.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_specs_are_stored_in_glazier_cores_json() {
        let video = StepSpec::ConvertVideo {
            video: VideoTrackPlan::Encode {
                codec: ArchiveVideoCodec::Av1,
            },
            audio: AudioTrackPlan::Copy,
            quality: VideoQuality::High,
            require_smaller: true,
        };
        assert_eq!(
            serde_json::to_string(&video).unwrap(),
            r#"{"kind":"convert-video","video":{"action":"encode","codec":"av1"},"audio":{"action":"copy"},"quality":"high","requireSmaller":true}"#
        );
        let hold = StepSpec::Hold {
            reason: "System junk".into(),
        };
        assert_eq!(
            serde_json::to_string(&hold).unwrap(),
            r#"{"kind":"hold","reason":"System junk"}"#
        );
        assert_eq!(
            serde_json::to_string(&StepSpec::RemoveFolder).unwrap(),
            r#"{"kind":"remove-folder"}"#
        );
        let animation = StepSpec::ConvertAnimation {
            mime_type: AnimatedImageMimeType::Gif,
        };
        assert_eq!(
            serde_json::to_string(&animation).unwrap(),
            r#"{"kind":"convert-animation","mimeType":"image/gif"}"#
        );
        let parsed: StepSpec = serde_json::from_str(r#"{"kind":"move"}"#).unwrap();
        assert_eq!(parsed, StepSpec::Move);
    }

    #[test]
    fn file_names_and_folders_are_checked_as_glazier_core_checks_them() {
        assert!(is_plain_file_name("cover.avif"));
        assert!(!is_plain_file_name(".."));
        assert!(!is_plain_file_name("a/b"));
        assert!(!is_plain_file_name(&"x".repeat(256)));
        assert!(is_within(Path::new("/r/a/b"), Path::new("/r")));
        assert!(is_within(Path::new("/r"), Path::new("/r")));
        assert!(!is_within(Path::new("/rb/a"), Path::new("/r")));
        assert!(!is_within(Path::new("/r/..x"), Path::new("/r")));
    }
}
