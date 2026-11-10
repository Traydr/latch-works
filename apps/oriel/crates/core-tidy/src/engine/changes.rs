//! The engine's changes to the archive: drafting and applying plans, undoing them, Tidy up, the
//! follow-ups a change leaves, the history, holding and Convert's estimates.
//!
//! What a change leaves to do (a scan when files changed under a plan or came back with an
//! undo, the analysis new files need) comes back as a [`FollowUp`] for the caller to run with
//! [`TidyEngine::follow_up`] on work of its own, so the change ends when the change does.
//!
//! A sandboxed run (`ORIEL_DATA_DIR` set) holds here too: a plan with a step in a root outside
//! the sandbox is refused before anything is touched.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError};

use anyhow::{Context as _, bail};
use oriel_avif::Libavif;
use oriel_runtime::release_free_memory;
use rusqlite::Connection;

use super::schedule::{Priority, Turn};
use super::{AnalysisKind, Inner, Queued, TidyEngine, on_thread};
use crate::catalog::files::{list_file_ids, roots_of_files};
use crate::catalog::roots::{list_roots, read_settings};
use crate::contract::{
    AudioState, CategoryCount, EmptyHoldingResult, EncoderCapabilities, ExtensionFix, FileFilter,
    FileId, FileKind, FileRow, HoldingId, HoldingList, HoldingRequest, MAX_HISTORY_ROWS,
    OptimizeCategory, OptimizeEstimate, OptimizeSummary, PlanId, PlanListRequest, PlanPreview,
    PlanRequest, PlanStatus, PlanStepPage, PlanStepsRequest, PlanSummary, RootId, VideoQuality,
};
use crate::media::convert::{Conversion, Converter, pixels};
use crate::media::transcode::encoder_capabilities;
use crate::optimize::summarize_candidates;
use crate::passes::{Progress, Quiet};
use crate::paths::sandbox_rule;
use crate::plans::encode_budget::still_concurrency;
use crate::plans::executor::{ExecutorDeps, apply_plan, undo_plan};
use crate::plans::holding::{
    HoldingStore, held_batch_paths, list_holding, mark_batches_emptied, restore_held,
};
use crate::plans::journal::{get_plan, list_plan_steps, list_plans, plan_root_ids, plan_subject};
use crate::plans::planner::{PlanRequestError, PlannerContext, draft_steps, save_plan};
use crate::plans::wording::{apply_label, doing_label, undo_label};

/// Work a change leaves for the engine: scans of roots whose files changed under the plan (or
/// came back with an undo), and the analysis new files need.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FollowUp {
    pub rescan: Vec<RootId>,
    pub analyze: Vec<RootId>,
}

impl FollowUp {
    pub fn is_empty(&self) -> bool {
        self.rescan.is_empty() && self.analyze.is_empty()
    }

    fn merge(&mut self, other: FollowUp) {
        for root in other.rescan {
            if !self.rescan.contains(&root) {
                self.rescan.push(root);
            }
        }
        for root in other.analyze {
            if !self.analyze.contains(&root) {
                self.analyze.push(root);
            }
        }
    }
}

/// What applying a plan did. A stopped apply still finishes with this, its plan `cancelled`, so
/// the owner can be told how far it got and undo it.
#[derive(Clone, Debug, PartialEq)]
pub struct Applied {
    pub plan: PlanSummary,
    pub follow_up: FollowUp,
}

/// What `perform` did: the plan as drafted, then as applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Performed {
    pub preview: PlanPreview,
    pub applied: Applied,
}

/// What undoing did. `complete` is false when a step could not be undone yet (a file another
/// program holds open) or the undo was stopped part way, with `message` saying so; the plan
/// stays undoable then.
#[derive(Clone, Debug, PartialEq)]
pub struct Undone {
    pub plans: Vec<PlanSummary>,
    pub complete: bool,
    pub message: Option<String>,
    pub follow_up: FollowUp,
}

/// What Tidy up did: the plans that changed something, in the order they ran, and notes on what
/// stopped or failed.
#[derive(Clone, Debug, PartialEq)]
pub struct TidiedUp {
    pub plans: Vec<PlanSummary>,
    pub notes: Vec<String>,
    pub follow_up: FollowUp,
}

impl TidiedUp {
    /// The plans one Undo takes back, newest last.
    pub fn undoable(&self) -> Vec<PlanId> {
        self.plans
            .iter()
            .filter(|plan| plan.can_undo())
            .map(|plan| plan.id)
            .collect()
    }
}

/// What restoring held files did: how many came back, why the others did not, and the scans of
/// the roots they came back into.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Restored {
    pub restored: i64,
    pub failed: Vec<String>,
    pub follow_up: FollowUp,
}

/// What a follow-up did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FollowUpReport {
    pub scanned: Vec<RootId>,
    pub analyzed: Vec<RootId>,
}

/// An estimate kept while its category holds the same files, bytes and quality.
#[derive(Clone, Debug)]
pub(super) struct CachedEstimate {
    files: i64,
    bytes: i64,
    quality: VideoQuality,
    estimate: OptimizeEstimate,
}

impl CachedEstimate {
    fn fits(&self, count: &CategoryCount, quality: VideoQuality) -> bool {
        self.files == count.files && self.bytes == count.bytes && self.quality == quality
    }
}

/// Why an operation on a plan that has been deleted fails.
const NO_PLAN: &str = "That plan no longer exists.";

/// What the activity panel says while held files go back, or holding goes to the Trash.
const RESTORING: &str = "Restoring held files";
const EMPTYING: &str = "Emptying holding";

/// Samples per category an estimate converts; videos take longest, so fewer of them.
const VIDEO_SAMPLES: usize = 3;

const STILL_SAMPLES: usize = 8;

impl Inner {
    /// Every root the plans have a step in, which their change's turn holds against removal.
    fn plan_roots(&self, plan_ids: &[PlanId]) -> anyhow::Result<Vec<RootId>> {
        let plan_ids = plan_ids.to_vec();
        self.catalog.blocking(move |connection| {
            let mut roots = Vec::new();
            for plan_id in plan_ids {
                for root_id in plan_root_ids(connection, plan_id)? {
                    if !roots.contains(&root_id) {
                        roots.push(root_id);
                    }
                }
            }
            Ok(roots)
        })
    }

    /// Every root the held files came from, which their restore's turn holds against removal.
    fn holding_roots(&self, ids: &[HoldingId]) -> anyhow::Result<Vec<RootId>> {
        let ids = ids.to_vec();
        self.catalog.blocking(move |connection| {
            let mut roots = Vec::new();
            for id in ids {
                if let Some(record) = crate::plans::holding::holding_record_by_id(connection, id)?
                    && !roots.contains(&record.root_id)
                {
                    roots.push(record.root_id);
                }
            }
            Ok(roots)
        })
    }

    /// What the planner reads for a request.
    fn planner_context(&self, connection: &Connection) -> anyhow::Result<PlannerContext> {
        Ok(PlannerContext {
            roots: list_roots(connection)?,
            settings: read_settings(connection)?,
        })
    }

    /// Saves a request as a draft plan, refusing, in a sandboxed run, a move into a folder outside
    /// the sandbox.
    fn preview(
        &self,
        connection: &mut Connection,
        request: &PlanRequest,
    ) -> anyhow::Result<PlanPreview> {
        if let PlanRequest::Move { target_dir, .. } = request {
            let target = std::path::absolute(target_dir)?;
            if !self.data.admits_tidy_root(&target) {
                bail!(PlanRequestError::Refused(format!(
                    "{} is outside Tidy's sandbox. {}",
                    target.display(),
                    sandbox_rule(&self.data)
                )));
            }
        }
        let context = self.planner_context(connection)?;
        let draft = draft_steps(connection, &context, request)?;
        let preview = save_plan(connection, &context, request.kind(), &draft)?;
        Ok(preview)
    }

    /// The roots a plan has steps in, each through [`Inner::admit`].
    fn check_plan_roots(&self, plan_id: PlanId) -> anyhow::Result<Vec<RootId>> {
        let root_ids = self
            .catalog
            .blocking(move |connection| plan_root_ids(connection, plan_id))?;
        for root_id in &root_ids {
            self.admit(*root_id)?;
        }
        Ok(root_ids)
    }

    /// What this machine can encode with; the first call asks ffmpeg, which takes a moment.
    pub(super) fn capabilities(&self) -> EncoderCapabilities {
        *self.capabilities.get_or_init(|| {
            encoder_capabilities(
                self.media.ffmpeg.as_deref(),
                self.media.ffprobe.is_some(),
                Libavif::get().is_ok(),
            )
        })
    }

    fn executor<'a>(&'a self, progress: &'a dyn Progress) -> anyhow::Result<ExecutorDeps<'a>> {
        let roots = self.catalog.blocking(|connection| list_roots(connection))?;
        Ok(ExecutorDeps {
            catalog: &self.catalog,
            places: &self.places,
            media: &self.media,
            libavif: Libavif::get().map_err(|error| error.to_string()),
            svt_av1: self.capabilities().video.av1,
            still_concurrency: still_concurrency(),
            encode_budget: &self.encode_budget,
            roots,
            progress,
        })
    }

    fn plan_summary(&self, plan_id: PlanId) -> anyhow::Result<PlanSummary> {
        self.catalog
            .blocking(move |connection| get_plan(connection, plan_id))?
            .context(NO_PLAN)
    }

    /// Drafts a request and applies it, with the turn held.
    fn perform_locked(
        self: &Arc<Self>,
        request: &PlanRequest,
        progress: &dyn Progress,
    ) -> anyhow::Result<Performed> {
        let planner = self.clone();
        let request = request.clone();
        let preview = self
            .catalog
            .blocking(move |connection| planner.preview(connection, &request))?;
        let plan_id = preview.plan_id;
        if let Some(subject) = self
            .catalog
            .blocking(move |connection| plan_subject(connection, plan_id))?
        {
            progress.phase(&apply_label(&subject), 0);
        }
        let applied = self.apply_locked(plan_id, progress).map_err(|error| {
            match self.plan_summary(plan_id) {
                Ok(plan) => anyhow::Error::new(PlanFailed { plan, error }),
                Err(_) => error,
            }
        })?;
        Ok(Performed { preview, applied })
    }

    /// Applies a plan with the work lock held.
    fn apply_locked(&self, plan_id: PlanId, progress: &dyn Progress) -> anyhow::Result<Applied> {
        let root_ids = self.check_plan_roots(plan_id)?;
        let deps = self.executor(progress)?;
        let outcome = apply_plan(&deps, plan_id);
        // Convert's encodes hold 30 bytes a pixel each, freed but kept by the allocator.
        release_free_memory();
        // Files that changed or left since the scan were skipped; a scan catches the catalog up,
        // so the next try acts on what is there now. A stopped apply settled its plan as
        // cancelled and does not count what it skipped, so it rescans too.
        let rescan = match outcome {
            Ok(result) => result.stale_steps > 0,
            Err(error) if progress.check().is_err() => {
                log::info!("Tidy stopped a change: {error:#}");
                true
            }
            Err(error) => return Err(error),
        };
        Ok(Applied {
            plan: self.plan_summary(plan_id)?,
            follow_up: FollowUp {
                rescan: if rescan { root_ids.clone() } else { Vec::new() },
                // Conversions write files that need fingerprints and, without copied audio,
                // loudness.
                analyze: root_ids,
            },
        })
    }

    /// Undoes plans newest first with the work lock held, stopping at the first that does not
    /// finish.
    fn undo_locked(&self, plan_ids: &[PlanId], progress: &dyn Progress) -> anyhow::Result<Undone> {
        let mut undone = Undone {
            plans: Vec::new(),
            complete: true,
            message: None,
            follow_up: FollowUp::default(),
        };
        for &plan_id in plan_ids.iter().rev() {
            let subject = self
                .catalog
                .blocking(move |connection| plan_subject(connection, plan_id))?
                .context(NO_PLAN)?;
            progress.phase(&undo_label(&subject), 0);
            let root_ids = self.check_plan_roots(plan_id)?;
            let deps = self.executor(progress)?;
            let outcome = undo_plan(&deps, plan_id);
            // Rescanned even when a file in use stopped part of it, for the steps that came back.
            undone.follow_up.merge(FollowUp {
                rescan: root_ids,
                analyze: Vec::new(),
            });
            undone.plans.push(self.plan_summary(plan_id)?);
            if let Err(error) = outcome {
                undone.complete = false;
                // Stopped, what came back stays back, and its scan is still to come.
                undone.message = Some(if progress.check().is_err() {
                    log::info!("Tidy stopped an undo: {error:#}");
                    "Stopped. What came back stays back; Undo again to finish.".to_owned()
                } else {
                    format!("{error:#}")
                });
                break;
            }
        }
        Ok(undone)
    }
}

impl TidyEngine {
    /// What this machine can encode with, asked of ffmpeg once, on a thread of its own.
    pub fn capabilities(
        &self,
    ) -> impl Future<Output = anyhow::Result<EncoderCapabilities>> + Send + use<> {
        let inner = self.inner.clone();
        on_thread("tidy-capabilities", move || Ok(inner.capabilities()))
    }

    /// Drafts a request as a plan and returns what it would do, without applying it.
    pub fn preview_plan(
        &self,
        request: PlanRequest,
    ) -> impl Future<Output = anyhow::Result<PlanPreview>> + Send + use<> {
        self.query(move |inner, connection| inner.preview(connection, &request))
    }

    /// Drafts a request once its turn comes, so it sees what the changes before it did, and
    /// applies it at once. Its warnings say what the change left out, for the result to report,
    /// and never hold it back, since it can be undone. AVIF encodes run several at once; every
    /// other step runs in order. Stopped part way, it still finishes, its plan `cancelled`.
    pub fn perform(&self, request: PlanRequest) -> Queued<Performed> {
        let ticket = self.inner.scheduler.ticket(Priority::AskedFor, Vec::new());
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            ticket.set_roots(inner.request_roots(&request)?);
            let turn = ticket.wait(progress)?;
            let performed = inner.perform_locked(&request, &turn)?;
            Ok(performed)
        })
    }

    /// Undoes plans as one change, newest first, stopping at the first that does not finish:
    /// held files come back, moved files move back, a converted file goes to holding and its
    /// original returns.
    pub fn undo(&self, plan_ids: Vec<PlanId>) -> Queued<Undone> {
        let ticket = self.inner.scheduler.ticket(Priority::AskedFor, Vec::new());
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            ticket.set_roots(inner.plan_roots(&plan_ids)?);
            let turn = ticket.wait(progress)?;
            let undone = inner.undo_locked(&plan_ids, &turn)?;
            Ok(undone)
        })
    }

    /// [`Self::undo`] of plans chosen once its turn comes, for an Undo asked for while changes
    /// still run that will decide what it takes back: `choose` runs with the turn held and may
    /// wait for them to be reported. `None` from it undoes nothing.
    pub fn undo_chosen(
        &self,
        choose: impl FnOnce() -> Option<Vec<PlanId>> + Send + 'static,
    ) -> Queued<Option<Undone>> {
        let ticket = self.inner.scheduler.ticket(Priority::AskedFor, Vec::new());
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            let turn = ticket.wait(progress)?;
            let Some(plan_ids) = choose() else {
                return Ok(None);
            };
            progress.check()?;
            let undone = inner.undo_locked(&plan_ids, &turn)?;
            Ok(Some(undone))
        })
    }

    /// Every plan but drafts, newest first.
    pub fn list_plans(
        &self,
        request: PlanListRequest,
    ) -> impl Future<Output = anyhow::Result<Vec<PlanSummary>>> + Send + use<> {
        self.query(move |_, connection| {
            list_plans(
                connection,
                &PlanListRequest {
                    limit: request.limit.clamp(1, MAX_HISTORY_ROWS),
                    ..request
                },
            )
        })
    }

    /// One plan, whatever its status.
    pub fn get_plan(
        &self,
        plan_id: PlanId,
    ) -> impl Future<Output = anyhow::Result<PlanSummary>> + Send + use<> {
        self.query(move |_, connection| get_plan(connection, plan_id)?.context(NO_PLAN))
    }

    /// One page of a plan's steps.
    pub fn plan_steps(
        &self,
        request: PlanStepsRequest,
    ) -> impl Future<Output = anyhow::Result<PlanStepPage>> + Send + use<> {
        self.query(move |_, connection| {
            list_plan_steps(
                connection,
                &PlanStepsRequest {
                    limit: request.limit.clamp(1, MAX_HISTORY_ROWS),
                    ..request
                },
            )
        })
    }

    /// A root's held files, newest first.
    pub fn list_holding(
        &self,
        request: HoldingRequest,
    ) -> impl Future<Output = anyhow::Result<HoldingList>> + Send + use<> {
        self.query(move |_, connection| {
            list_holding(
                connection,
                &HoldingRequest {
                    limit: request.limit.clamp(1, MAX_HISTORY_ROWS),
                    ..request
                },
            )
        })
    }

    /// Moves held files back where they came from, once its turn comes. One that cannot come back
    /// (something sits at its place) is reported and stays held. The roots that got files back
    /// are scanned by the follow-up.
    pub fn restore_holding(&self, ids: Vec<HoldingId>) -> Queued<Restored> {
        let ticket = self.inner.scheduler.ticket(Priority::AskedFor, Vec::new());
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            ticket.set_roots(inner.holding_roots(&ids)?);
            let _turn = ticket.wait(progress)?;
            progress.phase(RESTORING, ids.len() as u64);
            let mut restored = Restored::default();
            for (done, id) in ids.into_iter().enumerate() {
                progress.done(done as u64);
                let held = inner.catalog.blocking(move |connection| {
                    crate::plans::holding::holding_record_by_id(connection, id)
                })?;
                if let Some(record) = &held
                    && let Err(error) = inner.admit(record.root_id)
                {
                    restored.failed.push(format!("{error:#}"));
                    continue;
                }
                let store = HoldingStore {
                    catalog: &inner.catalog,
                    places: &inner.places,
                };
                match restore_held(store, id) {
                    Ok(record) => {
                        restored.restored += 1;
                        restored.follow_up.merge(FollowUp {
                            rescan: vec![record.root_id],
                            analyze: Vec::new(),
                        });
                    }
                    Err(error) => restored.failed.push(format!("{error}")),
                }
            }
            Ok(restored)
        })
    }

    /// Empties a root's holding into the Trash, batch by batch, once its turn comes, so a change
    /// asked for before it (an Undo that needs what is held) runs first. A batch the Trash
    /// refuses stays held and is reported. Only folders inside Tidy's own holding are ever
    /// trashed.
    pub fn empty_holding(&self, root_id: RootId) -> Queued<EmptyHoldingResult> {
        let ticket = self
            .inner
            .scheduler
            .ticket(Priority::AskedFor, vec![root_id]);
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            let _turn = ticket.wait(progress)?;
            inner.admit(root_id)?;
            let batches = inner
                .catalog
                .blocking(move |connection| held_batch_paths(connection, root_id))?;
            progress.phase(EMPTYING, batches.len() as u64);
            let mut trashed = Vec::new();
            let mut failed = Vec::new();
            for (done, batch) in batches.into_iter().enumerate() {
                progress.done(done as u64);
                // A batch in the data folder's holding, or at the top of the root's own volume;
                // never a folder anywhere else.
                let path = Path::new(&batch);
                if !inner.places.holds(path) {
                    failed.push(format!(
                        "{batch}: not one of Tidy's holding folders, or its volume is not connected"
                    ));
                    continue;
                }
                // A batch whose folder is gone from its holding place (held files left on a volume
                // that was not there, or taken out by hand) has nothing to trash; it empties all
                // the same, rather than staying in holding for good.
                if fs::symlink_metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    trashed.push(batch);
                    continue;
                }
                match inner.places.trash(path) {
                    Ok(()) => trashed.push(batch),
                    Err(error) => failed.push(format!("{batch}: {error}")),
                }
            }
            let store = HoldingStore {
                catalog: &inner.catalog,
                places: &inner.places,
            };
            let emptied = mark_batches_emptied(store, root_id, &trashed)?;
            Ok(EmptyHoldingResult { emptied, failed })
        })
    }

    /// Every extension Clean up would fix under a root, with the name it would give each file.
    pub fn extension_fixes(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<ExtensionFix>>> + Send + use<> {
        self.query(move |inner, connection| {
            let scan = inner.candidates(connection, root_id)?;
            Ok(
                crate::optimize::extension_fixes(connection, root_id, &scan.candidates)?
                    .into_iter()
                    .map(|(record, name)| ExtensionFix {
                        file: record.to_file_row(),
                        name,
                    })
                    .collect(),
            )
        })
    }

    /// The files Convert would change in `categories` under a root, in path order, at most
    /// `limit` of them: what one of Convert's sections shows.
    pub fn convertible_files(
        &self,
        root_id: RootId,
        categories: Vec<OptimizeCategory>,
        limit: usize,
    ) -> impl Future<Output = anyhow::Result<Vec<FileRow>>> + Send + use<> {
        self.query(move |inner, connection| {
            let mut rows: Vec<FileRow> = inner
                .candidates(connection, root_id)?
                .candidates
                .into_iter()
                .filter(|candidate| categories.contains(&candidate.category))
                .map(|candidate| candidate.record.to_file_row())
                .collect();
            rows.sort_by_cached_key(|row| row.rel_path.to_ascii_lowercase());
            rows.truncate(limit);
            Ok(rows)
        })
    }

    /// What converting a category would save, from a sample converted into a temp folder, never
    /// the archive. Kept while the category holds the same files and bytes at the same video
    /// quality, so asking each time Tidy opens does not encode the samples again; Overview's
    /// counts carry the one kept for them.
    pub fn estimate_optimize(
        &self,
        root_id: RootId,
        category: OptimizeCategory,
    ) -> impl Future<Output = anyhow::Result<OptimizeEstimate>> + Send + use<> {
        let inner = self.inner.clone();
        on_thread("tidy estimate", move || {
            let lookup = inner.clone();
            let (pool, count, quality) = inner.catalog.blocking(move |connection| {
                let scan = lookup.candidates(connection, root_id)?;
                let count = summarize_candidates(&scan, &Default::default())
                    .categories
                    .into_iter()
                    .find(|count| count.category == category)
                    .context("Convert has no such category")?;
                let pool: Vec<_> = scan
                    .candidates
                    .into_iter()
                    .filter(|candidate| candidate.category == category)
                    .collect();
                Ok((pool, count, read_settings(connection)?.reencode_quality))
            })?;
            let key = (root_id, category);
            if let Some(cached) = inner
                .estimates
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&key)
                .filter(|cached| cached.fits(&count, quality))
            {
                return Ok(cached.estimate.clone());
            }
            let estimate = inner.sample_estimate(category, pool, quality);
            inner
                .estimates
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    key,
                    CachedEstimate {
                        files: count.files,
                        bytes: count.bytes,
                        quality,
                        estimate: estimate.clone(),
                    },
                );
            Ok(estimate)
        })
    }

    /// Tidy up as one change: Clean up, then the silent soundtracks, then Convert in
    /// `categories` (none for Clean up's own "do all"), each step there is work for, run as
    /// [`Self::perform_steps`] runs them. Duplicates are not a step: which copy to keep depends
    /// on where each one is, so the owner decides every set.
    pub fn tidy_up(&self, root_id: RootId, categories: Vec<OptimizeCategory>) -> Queued<TidiedUp> {
        let ticket = self
            .inner
            .scheduler
            .ticket(Priority::AskedFor, vec![root_id]);
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            let turn = ticket.wait(progress)?;
            let overview_inner = inner.clone();
            let tidy = inner
                .catalog
                .blocking(move |connection| overview_inner.overview(connection, root_id))?;
            let steps: Vec<TidyStep> = [
                (tidy.cleanup.count() > 0)
                    .then_some(TidyStep::Plan(PlanRequest::Cleanup { root_id })),
                (tidy.silent_tracks.files > 0).then_some(TidyStep::SilentVideos(root_id)),
                (!categories.is_empty()).then_some(TidyStep::Plan(PlanRequest::Optimize {
                    root_id,
                    categories,
                    file_ids: None,
                })),
            ]
            .into_iter()
            .flatten()
            .collect();
            Ok(inner.perform_steps_locked(steps, turn))
        })
    }

    /// Several plans as one change, each drafted once the one before has finished. A step with
    /// nothing left to do (its files went in an earlier step) is skipped; one that fails is
    /// noted and the rest go on; a stop ends it, keeping what ran. One Undo takes it all back
    /// ([`TidiedUp::undoable`] with [`TidyEngine::undo`]).
    pub fn perform_steps(&self, steps: Vec<TidyStep>) -> Queued<TidiedUp> {
        let ticket = self.inner.scheduler.ticket(Priority::AskedFor, Vec::new());
        let inner = self.inner.clone();
        Queued::work(move |progress| {
            let mut roots = Vec::new();
            for step in &steps {
                let step_roots = match step {
                    TidyStep::Plan(request) => inner.request_roots(request)?,
                    TidyStep::SilentVideos(root_id) => vec![*root_id],
                };
                for root_id in step_roots {
                    if !roots.contains(&root_id) {
                        roots.push(root_id);
                    }
                }
            }
            ticket.set_roots(roots);
            let turn = ticket.wait(progress)?;
            Ok(inner.perform_steps_locked(steps, turn))
        })
    }

    /// Runs what a change left to do (see [`FollowUp`]): the scans first, as asked-for work,
    /// then in the background the analysis they and the change call for, of each
    /// root whose files need it with background analysis on. Roots forgotten since are skipped.
    pub fn follow_up(&self, follow_up: FollowUp) -> Queued<FollowUpReport> {
        let ticket = (!follow_up.rescan.is_empty()).then(|| {
            self.inner
                .scheduler
                .ticket(Priority::AskedFor, follow_up.rescan.clone())
        });
        let engine = self.clone();
        Queued::work(move |progress| {
            let mut report = FollowUpReport::default();
            let roots: Vec<RootId> = engine
                .inner
                .catalog
                .blocking(|connection| list_roots(connection))?
                .into_iter()
                .map(|root| root.id)
                .collect();
            let rescan: Vec<RootId> = follow_up
                .rescan
                .iter()
                .copied()
                .filter(|root_id| roots.contains(root_id))
                .collect();
            let mut catch_up: Vec<RootId> = Vec::new();
            if !rescan.is_empty() {
                let turn = match ticket {
                    Some(ticket) => ticket.wait(progress)?,
                    None => engine.inner.scheduler.take_turn(
                        Priority::AskedFor,
                        rescan.clone(),
                        progress,
                    )?,
                };
                for &root_id in &rescan {
                    let scanned = engine.scan_locked(root_id, &turn)?;
                    report.scanned.push(root_id);
                    if scanned.analysis_due {
                        catch_up.push(root_id);
                    }
                }
            }
            let mut analyze: Vec<(RootId, AnalysisKind)> = catch_up
                .into_iter()
                .map(|root_id| (root_id, AnalysisKind::CatchingUp))
                .collect();
            for &root_id in &follow_up.analyze {
                if roots.contains(&root_id)
                    && !report.scanned.contains(&root_id)
                    && engine.inner.analysis_due(root_id)?
                {
                    analyze.push((root_id, AnalysisKind::AfterChange));
                }
            }
            for (root_id, kind) in analyze {
                if !report.analyzed.contains(&root_id) {
                    engine.analyze(root_id, kind).run(progress)?;
                    report.analyzed.push(root_id);
                }
            }
            Ok(report)
        })
    }
}

impl Inner {
    /// The roots a request is about, which its turn holds against removal before it is drafted.
    fn request_roots(&self, request: &PlanRequest) -> anyhow::Result<Vec<RootId>> {
        let file_ids: Vec<FileId> = match request {
            PlanRequest::Cleanup { root_id }
            | PlanRequest::CleanJunk { root_id }
            | PlanRequest::RemoveEmptyFolders { root_id }
            | PlanRequest::ShrinkVideos { root_id, .. }
            | PlanRequest::Optimize { root_id, .. } => return Ok(vec![*root_id]),
            PlanRequest::Hold { file_ids }
            | PlanRequest::Move { file_ids, .. }
            | PlanRequest::FixExtension { file_ids }
            | PlanRequest::Reencode { file_ids, .. }
            | PlanRequest::StripAudio { file_ids } => file_ids.clone(),
            PlanRequest::Rename { renames } => {
                renames.iter().map(|rename| rename.file_id).collect()
            }
            PlanRequest::ResolveDuplicates { groups } => groups
                .iter()
                .flat_map(|group| group.keep.iter().chain(&group.remove).copied())
                .collect(),
        };
        self.catalog
            .blocking(move |connection| roots_of_files(connection, &file_ids))
    }

    /// Gives each of Convert's counts under a root the estimate kept for it, if one fits.
    pub(super) fn attach_estimates(
        &self,
        connection: &Connection,
        root_id: RootId,
        summary: &mut OptimizeSummary,
    ) -> anyhow::Result<()> {
        let quality = read_settings(connection)?.reencode_quality;
        let estimates = self
            .estimates
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for count in &mut summary.categories {
            count.estimate = estimates
                .get(&(root_id, count.category))
                .filter(|cached| cached.fits(count, quality))
                .map(|cached| cached.estimate.clone());
        }
        Ok(())
    }
}

/// One step of several plans run as one change.
#[derive(Clone, Debug)]
pub enum TidyStep {
    Plan(PlanRequest),
    /// Every video of the root measured as silent, listed once the steps before have run.
    SilentVideos(RootId),
}

impl Inner {
    fn perform_steps_locked(self: &Arc<Self>, steps: Vec<TidyStep>, turn: Turn<'_>) -> TidiedUp {
        let progress: &dyn Progress = &turn;
        let mut tidied = TidiedUp {
            plans: Vec::new(),
            notes: Vec::new(),
            follow_up: FollowUp::default(),
        };
        for step in steps {
            // Paused between steps, it waits here; stopped, what ran stays, with its one Undo.
            if progress.checkpoint().is_err() {
                tidied.notes.push("Stopped".to_owned());
                break;
            }
            let request = match step {
                TidyStep::Plan(request) => request,
                TidyStep::SilentVideos(root_id) => {
                    match self
                        .catalog
                        .blocking(move |connection| silent_video_ids(connection, root_id))
                    {
                        Ok(ids) if ids.is_empty() => continue,
                        Ok(ids) => PlanRequest::StripAudio { file_ids: ids },
                        Err(error) => {
                            tidied.notes.push(format!("{error:#}"));
                            continue;
                        }
                    }
                }
            };
            progress.phase(&doing_label(request.kind()), 0);
            let applied = match self.perform_locked(&request, progress) {
                Ok(performed) => performed.applied,
                Err(error) if PlanRequestError::is_nothing_to_do(&error) => continue,
                Err(error) => {
                    // A step that failed part way counts with the rest, so the one Undo takes
                    // back what it did.
                    if let Some(plan) = PlanFailed::plan_of(&error).filter(|plan| plan.steps > 0) {
                        tidied.plans.push(plan.clone());
                    }
                    tidied.notes.push(format!("{error:#}"));
                    continue;
                }
            };
            tidied.follow_up.merge(applied.follow_up.clone());
            let plan = applied.plan;
            let (title, failed, status, steps) =
                (plan.title.clone(), plan.failed, plan.status, plan.steps);
            if steps > 0 {
                tidied.plans.push(plan);
            }
            if status == PlanStatus::Cancelled {
                tidied.notes.push(format!("Stopped during “{title}”"));
                break;
            }
            if status == PlanStatus::Failed || failed > 0 {
                tidied.notes.push(format!("{title}: {failed} failed"));
            }
        }
        tidied
    }
}

/// A plan whose apply failed part way: some of its steps may have run, which Undo takes back. It
/// carries the plan as the failure left it, read with the turn still held.
#[derive(Debug)]
pub struct PlanFailed {
    pub plan: PlanSummary,
    error: anyhow::Error,
}

impl PlanFailed {
    /// The plan of a failed change, when its apply had begun.
    pub fn plan_of(error: &anyhow::Error) -> Option<&PlanSummary> {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<PlanFailed>())
            .map(|failed| &failed.plan)
    }
}

impl std::fmt::Display for PlanFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.error)
    }
}

impl std::error::Error for PlanFailed {}

/// Every video of a root measured as silent.
fn silent_video_ids(connection: &Connection, root_id: RootId) -> anyhow::Result<Vec<FileId>> {
    Ok(list_file_ids(
        connection,
        &FileFilter {
            kinds: vec![FileKind::Video],
            audio_states: vec![AudioState::Silent],
            ..FileFilter::root(Some(root_id))
        },
    )?
    .ids)
}

/// The middle of sorted values, or the mean of the middle two; `None` for none.
fn median(sorted: &[f64]) -> Option<f64> {
    let middle = sorted.len() / 2;
    let upper = *sorted.get(middle)?;
    Some(
        match (sorted.len().is_multiple_of(2), middle.checked_sub(1)) {
            (true, Some(lower)) => (sorted[lower] + upper) / 2.0,
            _ => upper,
        },
    )
}

impl Inner {
    /// Converts an even spread of a category's files, smallest to largest, into a temp folder,
    /// and reads the size ratios. A sample that fails says nothing about size and is left out.
    fn sample_estimate(
        &self,
        category: OptimizeCategory,
        mut pool: Vec<crate::optimize::OptimizeCandidate>,
        quality: VideoQuality,
    ) -> OptimizeEstimate {
        pool.sort_by_key(|candidate| candidate.record.size);
        let wanted = match category {
            OptimizeCategory::VideoConvert | OptimizeCategory::VideoRemux => VIDEO_SAMPLES,
            _ => STILL_SAMPLES,
        };
        let count = wanted.min(pool.len());
        let sample: Vec<_> = (0..count)
            .filter_map(|index| {
                let position = ((index as f64 + 0.5) * pool.len() as f64 / count as f64).floor();
                pool.get(position as usize)
            })
            .collect();
        let unchanged = OptimizeEstimate {
            category,
            sampled: sample.len() as i64,
            ratio: 1.0,
            ratio_low: 1.0,
            ratio_high: 1.0,
        };
        if matches!(
            category,
            OptimizeCategory::RenameAvif | OptimizeCategory::RenameMp4
        ) || sample.is_empty()
        {
            return unchanged;
        }
        // Each estimate has a folder of its own: several start at once, one per category, and the
        // first to finish deletes its folder with whatever is in it.
        static NEXT_FOLDER: AtomicU64 = AtomicU64::new(0);
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-estimate-{}-{}",
            std::process::id(),
            NEXT_FOLDER.fetch_add(1, Ordering::Relaxed)
        ));
        // Nothing can be measured without it, which says "unknown", not "no saving".
        if let Err(error) = fs::create_dir_all(&folder) {
            log::warn!("Tidy could not make a folder for its estimate: {error}");
            return OptimizeEstimate {
                sampled: 0,
                ..unchanged
            };
        }
        let quiet = Quiet::new();
        let converter = Converter {
            media: &self.media,
            libavif: Libavif::get().map_err(|error| error.to_string()),
            budget: &self.encode_budget,
        };
        let ratio = |index: usize, candidate: &crate::optimize::OptimizeCandidate| {
            let source = candidate.record.abs_path();
            let extension = Path::new(&candidate.target_name)
                .extension()
                .map(|extension| format!(".{}", extension.to_string_lossy()))
                .unwrap_or_default();
            let out = folder.join(format!("{index}{extension}"));
            let conversion = match candidate.category {
                OptimizeCategory::StillToAvif => Conversion::Still {
                    pixels: pixels(candidate.record.width, candidate.record.height),
                },
                OptimizeCategory::AnimationToMp4 => Conversion::Animation,
                _ => {
                    let (video, audio) = candidate.tracks?;
                    Conversion::Video {
                        video,
                        audio,
                        quality,
                    }
                }
            };
            converter
                .convert(conversion, &source, &out, &quiet, &|_| {})
                .ok()
                .and_then(|()| fs::metadata(&out).ok())
                .map(|written| written.len() as f64 / (candidate.record.size.max(1)) as f64)
        };
        // A still's encode runs on one thread, so the eight run at once, within the memory
        // Convert's encodes may hold; ffmpeg's conversions use every core already, so they run
        // one after another. The ratios are sorted, so the order they come in changes nothing.
        let mut ratios: Vec<f64> = if category == OptimizeCategory::StillToAvif {
            let ratio = &ratio;
            std::thread::scope(|scope| {
                let runs: Vec<_> = sample
                    .iter()
                    .enumerate()
                    .map(|(index, candidate)| scope.spawn(move || ratio(index, candidate)))
                    .collect();
                runs.into_iter()
                    .filter_map(|run| run.join().ok().flatten())
                    .collect()
            })
        } else {
            sample
                .iter()
                .enumerate()
                .filter_map(|(index, candidate)| ratio(index, candidate))
                .collect()
        };
        if let Err(error) = fs::remove_dir_all(&folder) {
            log::warn!("Tidy could not remove {}: {error}", folder.display());
        }
        // The encodes' buffers, 30 bytes a pixel each, would otherwise stay with the process.
        release_free_memory();
        ratios.sort_by(f64::total_cmp);
        let at = |index: usize| ratios.get(index).copied().unwrap_or(1.0);
        OptimizeEstimate {
            category,
            sampled: ratios.len() as i64,
            ratio: median(&ratios).unwrap_or(1.0),
            ratio_low: at(((ratios.len().max(1) - 1) as f64 * 0.25).floor() as usize),
            ratio_high: at(((ratios.len().max(1) - 1) as f64 * 0.75).ceil() as usize),
        }
    }
}
