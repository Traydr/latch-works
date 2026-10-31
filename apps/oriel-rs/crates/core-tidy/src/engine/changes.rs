//! The engine's changes to the archive, after glazier-core's `engine/engine.ts` routes of the same
//! names: drafting and applying plans, undoing them, the history, holding, Convert's estimates,
//! and Tidy up.
//!
//! Each method is glazier-core's `EngineMethods` entry in snake case, with the contract's input
//! and result as Rust types (see [`crate::contract`]). Where glazier-core enqueues a job, this
//! returns an `oriel-runtime` [`Job`] whose progress names its phase ("Converting stills to
//! AVIF", 3 of 12), with a `_blocking` twin for tests and tools. What glazier-core then queues by
//! itself (a scan when files changed under a plan, the analysis new files need) comes back as a
//! [`FollowUp`] for the caller to start with [`TidyEngine::start_follow_up`], so a change's ring
//! on the switcher ends when the change does, as Electron Oriel's does.
//!
//! A sandboxed run (`ORIEL_RS_DATA_DIR` set) holds here too: a plan with a step in a root outside
//! the sandbox is refused before anything is touched.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::PoisonError;

use anyhow::{Context as _, bail};
use gpui_kit::{App, Entity, Task};
use oriel_avif::Libavif;
use oriel_runtime::{Job, JobReporter, release_free_memory};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::schedule::Priority;
use super::{ChangedOnDrop, Inner, TidyEngine, on_thread};
use crate::catalog::files::list_file_ids;
use crate::catalog::roots::{find_root, list_roots, read_settings};
use crate::contract::{
    AudioState, EmptyHoldingResult, EncoderCapabilities, FileFilter, FileId, FileKind, HoldingId,
    HoldingList, HoldingRequest, MAX_HISTORY_ROWS, OptimizeCategory, OptimizeEstimate, PlanId,
    PlanListRequest, PlanPreview, PlanRequest, PlanStatus, PlanStepPage, PlanStepsRequest,
    PlanSummary, RestoreResult, Root, RootId, VideoQuality,
};
use crate::media::still::encode_still_to_avif;
use crate::media::transcode::{TranscodeJob, encoder_capabilities, transcode_with_ffmpeg};
use crate::optimize::CandidateHolds;
use crate::passes::{Progress, Quiet};
use crate::plans::encode_budget::EncodeBudget;
pub use crate::plans::encode_budget::still_concurrency;
use crate::plans::executor::{ExecutorDeps, apply_plan, undo_plan};
use crate::plans::holding::{
    HoldingStore, held_batch_paths, list_holding, mark_batches_emptied, move_to_trash, restore_held,
};
use crate::plans::journal::{
    discard_draft, get_plan, list_plan_steps, list_plans, plan_root_ids, plan_subject,
};
use crate::plans::planner::{PlanRequestError, PlannerContext, draft_steps, save_plan};
use crate::plans::wording::{apply_label, doing_label, undo_label};

/// Work glazier-core queues by itself after a change, for the caller to start with
/// [`TidyEngine::start_follow_up`]: scans of roots whose files changed under the plan (or came
/// back with an undo), and the analysis new files need.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub plan: PlanSummary,
    pub follow_up: FollowUp,
}

/// What `perform` did: the plan as drafted, then as applied.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performed {
    pub preview: PlanPreview,
    pub applied: Applied,
}

/// What undoing did. `complete` is false when a step could not be undone yet (a file another
/// program holds open), with `message` saying so; the plan stays undoable then.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    pub plans: Vec<PlanSummary>,
    pub complete: bool,
    pub message: Option<String>,
    pub follow_up: FollowUp,
}

/// What Tidy up did: the plans that changed something, in the order they ran, and notes on what
/// stopped or failed, as the renderer's `performAll` reports them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidiedUp {
    pub plans: Vec<PlanSummary>,
    pub notes: Vec<String>,
    pub follow_up: FollowUp,
}

impl TidiedUp {
    /// The plans one Undo takes back, newest last, as the renderer's `undoAll` collects them.
    pub fn undoable(&self) -> Vec<PlanId> {
        self.plans
            .iter()
            .filter(|plan| plan.can_undo())
            .map(|plan| plan.id)
            .collect()
    }
}

/// What a follow-up did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpReport {
    pub scanned: Vec<RootId>,
    pub analyzed: Vec<RootId>,
}

/// An estimate kept while its category holds the same files, bytes and quality.
#[derive(Clone, Debug)]
pub(super) struct CachedEstimate {
    files: usize,
    bytes: i64,
    quality: VideoQuality,
    estimate: OptimizeEstimate,
}

/// Samples per category an estimate converts; videos take longest, so fewer of them.
const VIDEO_SAMPLES: usize = 3;

const STILL_SAMPLES: usize = 8;

fn root_or_error(connection: &Connection, root_id: RootId) -> anyhow::Result<Root> {
    find_root(connection, root_id)?.context("That root is no longer configured.")
}

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

    /// What the planner reads for a request, holds included for the kinds Convert and Clean up
    /// leave files alone in.
    fn planner_context(
        &self,
        connection: &Connection,
        request: &PlanRequest,
    ) -> anyhow::Result<PlannerContext> {
        let holds_root = match request {
            PlanRequest::Optimize { root_id, .. }
            | PlanRequest::Cleanup { root_id }
            | PlanRequest::ShrinkVideos { root_id, .. } => Some(*root_id),
            _ => None,
        };
        Ok(PlannerContext {
            roots: list_roots(connection)?,
            settings: read_settings(connection)?,
            candidate_holds: match holds_root {
                Some(root_id) => self.candidate_holds(connection, root_id)?,
                None => CandidateHolds::default(),
            },
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
                bail!(PlanRequestError(format!(
                    "With ORIEL_RS_DATA_DIR set, files move only into folders under {} or \
                     the temp folder.",
                    self.data.sandbox().display()
                )));
            }
        }
        let context = self.planner_context(connection, request)?;
        let draft = draft_steps(connection, &context, request)?;
        let preview = save_plan(connection, &context, request.kind(), &draft)?;
        Ok(preview)
    }

    /// Refuses, in a sandboxed run, a plan with a step in a root outside the sandbox.
    fn check_plan_roots(&self, plan_id: PlanId) -> anyhow::Result<Vec<RootId>> {
        let (root_ids, roots) = self.catalog.blocking(move |connection| {
            Ok((plan_root_ids(connection, plan_id)?, list_roots(connection)?))
        })?;
        for root_id in &root_ids {
            let root = roots
                .iter()
                .find(|root| root.id == *root_id)
                .context("That root is no longer configured.")?;
            if !self.data.admits_tidy_root(Path::new(&root.path)) {
                bail!(
                    "{} is outside Tidy's sandbox, so Tidy does not change it.",
                    root.path
                );
            }
        }
        Ok(root_ids)
    }

    fn svt_av1(&self) -> bool {
        self.capabilities().svt_av1
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
            svt_av1: self.svt_av1(),
            still_concurrency: still_concurrency(),
            encode_budget: EncodeBudget::for_this_machine(),
            roots,
            progress,
        })
    }

    fn plan_summary(&self, plan_id: PlanId) -> anyhow::Result<PlanSummary> {
        self.catalog
            .blocking(move |connection| get_plan(connection, plan_id))?
            .context("That plan no longer exists.")
    }

    /// Applies a plan with the work lock held.
    fn apply_locked(&self, plan_id: PlanId, progress: &dyn Progress) -> anyhow::Result<Applied> {
        let _changed = ChangedOnDrop(self);
        let root_ids = self.check_plan_roots(plan_id)?;
        let deps = self.executor(progress)?;
        let outcome = apply_plan(&deps, plan_id);
        self.changed();
        // Convert's encodes hold 30 bytes a pixel each, freed but kept by the allocator.
        release_free_memory();
        let stale_steps = match outcome {
            Ok(result) => result.stale_steps,
            // A stopped apply settled its plan as cancelled; what it did is in the summary.
            Err(error) if progress.check().is_err() => {
                log::info!("Tidy stopped a change: {error:#}");
                0
            }
            Err(error) => return Err(error),
        };
        Ok(Applied {
            plan: self.plan_summary(plan_id)?,
            follow_up: FollowUp {
                // Files that changed or left since the scan were skipped; a scan catches the
                // catalog up, so the next try acts on what is there now.
                rescan: if stale_steps > 0 {
                    root_ids.clone()
                } else {
                    Vec::new()
                },
                // Conversions write files that need fingerprints and, without copied audio,
                // loudness.
                analyze: root_ids,
            },
        })
    }

    /// Undoes plans newest first with the work lock held, stopping at the first that does not
    /// finish.
    fn undo_locked(&self, plan_ids: &[PlanId], progress: &dyn Progress) -> anyhow::Result<Undone> {
        let _changed = ChangedOnDrop(self);
        let mut undone = Undone {
            plans: Vec::new(),
            complete: true,
            message: None,
            follow_up: FollowUp::default(),
        };
        for &plan_id in plan_ids.iter().rev() {
            if self
                .catalog
                .blocking(move |connection| plan_subject(connection, plan_id))?
                .is_none()
            {
                bail!("That plan no longer exists.");
            }
            let root_ids = self.check_plan_roots(plan_id)?;
            let deps = self.executor(progress)?;
            let outcome = undo_plan(&deps, plan_id);
            self.changed();
            // Rescanned even when a file in use stopped part of it, for the steps that came back.
            undone.follow_up.merge(FollowUp {
                rescan: root_ids,
                analyze: Vec::new(),
            });
            undone.plans.push(self.plan_summary(plan_id)?);
            if let Err(error) = outcome {
                if progress.check().is_err() {
                    return Err(error);
                }
                undone.complete = false;
                undone.message = Some(format!("{error:#}"));
                break;
            }
        }
        Ok(undone)
    }
}

impl TidyEngine {
    /// What this machine can encode with (glazier-core's `capabilities`), asked of ffmpeg once,
    /// on a thread of its own.
    pub fn capabilities(
        &self,
    ) -> impl Future<Output = anyhow::Result<EncoderCapabilities>> + Send + 'static {
        let inner = self.inner.clone();
        on_thread("tidy-capabilities", move || Ok(inner.capabilities()))
    }

    // Plans.

    /// Drafts a request as a plan and returns what it would do (glazier-core's `previewPlan`).
    pub fn preview_plan(
        &self,
        request: PlanRequest,
    ) -> impl Future<Output = anyhow::Result<PlanPreview>> + Send + 'static {
        self.query(move |inner, connection| inner.preview(connection, &request))
    }

    /// Previews a request and applies it at once (glazier-core's `perform`). The preview comes
    /// back first, with the job applying it; its warnings say what the change left out, for the
    /// result to report, and never hold it back, since it can be undone.
    pub fn perform(
        &self,
        request: PlanRequest,
        cx: &mut App,
    ) -> Task<anyhow::Result<(PlanPreview, Entity<Job<Applied>>)>> {
        let engine = self.clone();
        let preview = self.preview_plan(request);
        cx.spawn(async move |cx| {
            let preview = preview.await?;
            let plan_id = preview.plan_id;
            // Named as glazier-core names its apply job: "Converting 206 files".
            let label = engine
                .inner
                .catalog
                .call(move |connection| plan_subject(connection, plan_id))
                .await?
                .map_or_else(
                    || "Changing files".to_owned(),
                    |subject| apply_label(&subject),
                );
            let job = cx.update(|cx| engine.start_apply_named(plan_id, label, cx));
            Ok((preview, job))
        })
    }

    /// Applies a reviewed plan on a job (glazier-core's `applyPlan`). AVIF encodes run several
    /// at once; every other step runs in order.
    pub fn start_apply(&self, plan_id: PlanId, cx: &mut App) -> Entity<Job<Applied>> {
        self.start_apply_named(plan_id, "Changing files".to_owned(), cx)
    }

    fn start_apply_named(
        &self,
        plan_id: PlanId,
        label: String,
        cx: &mut App,
    ) -> Entity<Job<Applied>> {
        let engine = self.clone();
        Job::start(label, cx, move |reporter: JobReporter| {
            on_thread("tidy change", move || {
                engine.apply_blocking(plan_id, &reporter)
            })
        })
    }

    /// [`TidyEngine::start_apply`]'s work, on the calling thread. Never call it from an executor.
    pub fn apply_blocking(
        &self,
        plan_id: PlanId,
        progress: &dyn Progress,
    ) -> anyhow::Result<Applied> {
        let inner = &self.inner;
        let roots = inner.plan_roots(&[plan_id])?;
        let turn = inner
            .scheduler
            .take_turn(Priority::AskedFor, roots, progress)?;
        if let Some(subject) = inner
            .catalog
            .blocking(move |connection| plan_subject(connection, plan_id))?
        {
            turn.phase(&apply_label(&subject), 0);
        }
        inner.apply_locked(plan_id, &turn)
    }

    /// [`TidyEngine::perform`]'s work, on the calling thread: drafts, then applies.
    pub fn perform_blocking(
        &self,
        request: PlanRequest,
        progress: &dyn Progress,
    ) -> anyhow::Result<Performed> {
        let inner = self.inner.clone();
        let preview = self
            .inner
            .catalog
            .blocking(move |connection| inner.preview(connection, &request))?;
        let applied = self.apply_blocking(preview.plan_id, progress)?;
        Ok(Performed { preview, applied })
    }

    /// Forgets a draft plan the owner chose not to apply.
    pub fn discard_plan(
        &self,
        plan_id: PlanId,
    ) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        self.query(move |_, connection| discard_draft(connection, plan_id))
    }

    /// Undoes a plan on a job (glazier-core's `undoPlan`): held files come back, moved files move
    /// back, a converted file goes to holding and its original returns.
    pub fn start_undo(&self, plan_id: PlanId, cx: &mut App) -> Entity<Job<Undone>> {
        self.start_undo_plans(vec![plan_id], cx)
    }

    /// Undoes several plans as one change, newest first, as the renderer's `undoPlans` does for
    /// Tidy up's one Undo. It stops at the first plan that does not finish.
    pub fn start_undo_plans(&self, plan_ids: Vec<PlanId>, cx: &mut App) -> Entity<Job<Undone>> {
        let engine = self.clone();
        Job::start("Undoing", cx, move |reporter: JobReporter| {
            on_thread("tidy undo", move || {
                engine.undo_plans_blocking(&plan_ids, &reporter)
            })
        })
    }

    /// [`TidyEngine::start_undo_plans`]'s work, on the calling thread.
    pub fn undo_plans_blocking(
        &self,
        plan_ids: &[PlanId],
        progress: &dyn Progress,
    ) -> anyhow::Result<Undone> {
        let inner = &self.inner;
        let roots = inner.plan_roots(plan_ids)?;
        let turn = inner
            .scheduler
            .take_turn(Priority::AskedFor, roots, progress)?;
        if let [plan_id] = plan_ids {
            let plan_id = *plan_id;
            if let Some(subject) = inner
                .catalog
                .blocking(move |connection| plan_subject(connection, plan_id))?
            {
                turn.phase(&undo_label(&subject), 0);
            }
        }
        inner.undo_locked(plan_ids, &turn)
    }

    /// [`TidyEngine::start_undo`]'s work, on the calling thread.
    pub fn undo_blocking(
        &self,
        plan_id: PlanId,
        progress: &dyn Progress,
    ) -> anyhow::Result<Undone> {
        self.undo_plans_blocking(&[plan_id], progress)
    }

    // History.

    /// Every plan but drafts, newest first (glazier-core's `listPlans`).
    pub fn list_plans(
        &self,
        request: PlanListRequest,
    ) -> impl Future<Output = anyhow::Result<Vec<PlanSummary>>> + Send + 'static {
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

    /// One plan, whatever its status (glazier-core's `getPlan`).
    pub fn get_plan(
        &self,
        plan_id: PlanId,
    ) -> impl Future<Output = anyhow::Result<PlanSummary>> + Send + 'static {
        self.query(move |_, connection| {
            get_plan(connection, plan_id)?.context("That plan no longer exists.")
        })
    }

    /// One page of a plan's steps (glazier-core's `planSteps`).
    pub fn plan_steps(
        &self,
        request: PlanStepsRequest,
    ) -> impl Future<Output = anyhow::Result<PlanStepPage>> + Send + 'static {
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

    // Holding.

    /// A root's held files, newest first (glazier-core's `listHolding`).
    pub fn list_holding(
        &self,
        request: HoldingRequest,
    ) -> impl Future<Output = anyhow::Result<HoldingList>> + Send + 'static {
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

    /// Moves held files back where they came from (glazier-core's `restoreHolding`). One that
    /// cannot come back (something sits at its place) is reported and stays held. The roots
    /// that got files back want a scan, which glazier-core queues: they are in `rescan`.
    pub fn restore_holding(
        &self,
        ids: Vec<HoldingId>,
    ) -> impl Future<Output = anyhow::Result<RestoreResult>> + Send + 'static {
        let inner = self.inner.clone();
        on_thread("tidy restore", move || {
            let roots = inner
                .catalog
                .blocking(|connection| list_roots(connection))?;
            let mut result = RestoreResult::default();
            for id in ids {
                let held = inner.catalog.blocking(move |connection| {
                    crate::plans::holding::holding_record_by_id(connection, id)
                })?;
                let admitted = held.as_ref().is_some_and(|record| {
                    roots.iter().any(|root| {
                        root.id == record.root_id
                            && inner.data.admits_tidy_root(Path::new(&root.path))
                    })
                });
                if held.is_some() && !admitted {
                    result
                        .failed
                        .push("That file's root is outside Tidy's sandbox.".to_owned());
                    continue;
                }
                let store = HoldingStore {
                    catalog: &inner.catalog,
                    places: &inner.places,
                };
                match restore_held(store, id) {
                    Ok(record) => {
                        result.restored += 1;
                        if !result.rescan.contains(&record.root_id) {
                            result.rescan.push(record.root_id);
                        }
                    }
                    Err(error) => result.failed.push(format!("{error}")),
                }
            }
            inner.changed();
            Ok(result)
        })
    }

    /// The batch folders of a root that still hold something (glazier-core's
    /// `holdingBatches`).
    pub fn holding_batches(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<Vec<String>>> + Send + 'static {
        self.query(move |_, connection| {
            root_or_error(connection, root_id)?;
            held_batch_paths(connection, root_id)
        })
    }

    /// Records that batch folders went to the Trash (glazier-core's `markHoldingEmptied`).
    pub fn mark_holding_emptied(
        &self,
        root_id: RootId,
        batch_paths: Vec<String>,
    ) -> impl Future<Output = anyhow::Result<i64>> + Send + 'static {
        let inner = self.inner.clone();
        on_thread("tidy holding", move || {
            inner
                .catalog
                .blocking(move |connection| root_or_error(connection, root_id))?;
            let store = HoldingStore {
                catalog: &inner.catalog,
                places: &inner.places,
            };
            let emptied = mark_batches_emptied(store, root_id, &batch_paths)?;
            inner.changed();
            Ok(emptied)
        })
    }

    /// Empties a root's holding into the Trash, batch by batch, as Electron Oriel's main process
    /// does around `holdingBatches` and `markHoldingEmptied`. A batch the Trash refuses stays
    /// held and is reported. Only folders inside Tidy's own holding are ever trashed.
    pub fn empty_holding(
        &self,
        root_id: RootId,
    ) -> impl Future<Output = anyhow::Result<EmptyHoldingResult>> + Send + 'static {
        let inner = self.inner.clone();
        on_thread("tidy holding", move || {
            let batches = inner.catalog.blocking(move |connection| {
                root_or_error(connection, root_id)?;
                held_batch_paths(connection, root_id)
            })?;
            let mut trashed = Vec::new();
            let mut failed = Vec::new();
            for batch in batches {
                // A batch in the data folder's holding, or at the top of the root's own volume,
                // as Electron Oriel's `emptyHolding` takes any batch its catalog lists; never a
                // folder anywhere else.
                let path = Path::new(&batch);
                if !inner.places.holds(path) {
                    failed.push(format!(
                        "{batch}: not one of Tidy's holding folders, or its volume is not connected"
                    ));
                    continue;
                }
                // A batch whose folder is gone from its holding place (an import's held files
                // left on a volume that was not there) has nothing to trash; it empties all the
                // same, rather than staying in holding for good.
                if fs::symlink_metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    trashed.push(batch);
                    continue;
                }
                match move_to_trash(path) {
                    Ok(()) => trashed.push(batch),
                    Err(error) => failed.push(format!("{batch}: {error}")),
                }
            }
            let store = HoldingStore {
                catalog: &inner.catalog,
                places: &inner.places,
            };
            let emptied = mark_batches_emptied(store, root_id, &trashed)?;
            inner.changed();
            Ok(EmptyHoldingResult { emptied, failed })
        })
    }

    // Convert's estimates.

    /// What converting a category would save, from a sample converted into a temp folder, never
    /// the archive (glazier-core's `estimateOptimize`). Kept while the category holds the same
    /// number of files and bytes, so asking each time Tidy opens does not encode the samples
    /// again.
    pub fn estimate_optimize(
        &self,
        root_id: RootId,
        category: OptimizeCategory,
    ) -> impl Future<Output = anyhow::Result<OptimizeEstimate>> + Send + 'static {
        let inner = self.inner.clone();
        on_thread("tidy estimate", move || {
            let lookup = inner.clone();
            let (pool, quality) = inner.catalog.blocking(move |connection| {
                let pool: Vec<_> = lookup
                    .candidates(connection, root_id)?
                    .candidates
                    .into_iter()
                    .filter(|candidate| candidate.category == category)
                    .collect();
                Ok((pool, read_settings(connection)?.reencode_quality))
            })?;
            let bytes: i64 = pool.iter().map(|candidate| candidate.record.size).sum();
            let key = (root_id, category);
            if let Some(cached) = inner
                .estimates
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&key)
                .filter(|cached| {
                    cached.files == pool.len() && cached.bytes == bytes && cached.quality == quality
                })
            {
                return Ok(cached.estimate.clone());
            }
            let estimate = inner.sample_estimate(category, pool.clone(), quality);
            inner
                .estimates
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(
                    key,
                    CachedEstimate {
                        files: pool.len(),
                        bytes,
                        quality,
                        estimate: estimate.clone(),
                    },
                );
            Ok(estimate)
        })
    }

    // Tidy up.

    /// Tidy up as one change (Overview's ⌘↩): Clean up, then the silent soundtracks, then Convert
    /// in `categories`, each drafted once the one before has finished, as the renderer's
    /// `tidyUpSteps` and `performAll` run them. Duplicates are not a step: which copy to keep
    /// depends on where each one is, so the owner decides every set. One Undo takes it all back
    /// ([`TidiedUp::undoable`] with [`TidyEngine::start_undo_plans`]).
    pub fn start_tidy_up(
        &self,
        root_id: RootId,
        categories: Vec<OptimizeCategory>,
        cx: &mut App,
    ) -> Entity<Job<TidiedUp>> {
        let engine = self.clone();
        Job::start("Tidying up", cx, move |reporter: JobReporter| {
            on_thread("tidy up", move || {
                engine.tidy_up_blocking(root_id, &categories, &reporter)
            })
        })
    }

    /// [`TidyEngine::start_tidy_up`]'s work, on the calling thread.
    pub fn tidy_up_blocking(
        &self,
        root_id: RootId,
        categories: &[OptimizeCategory],
        progress: &dyn Progress,
    ) -> anyhow::Result<TidiedUp> {
        let inner = &self.inner;
        let turn = inner
            .scheduler
            .take_turn(Priority::AskedFor, vec![root_id], progress)?;
        let progress: &dyn Progress = &turn;
        let overview_inner = inner.clone();
        let tidy = inner
            .catalog
            .blocking(move |connection| overview_inner.overview(connection, root_id))?;
        let mut tidied = TidiedUp {
            plans: Vec::new(),
            notes: Vec::new(),
            follow_up: FollowUp::default(),
        };

        let cleanup = tidy.cleanup.junk + tidy.cleanup.empty_folders + tidy.cleanup.extensions > 0;
        let steps: [Option<TidyStep>; 3] = [
            cleanup.then_some(TidyStep::Cleanup),
            (tidy.silent_tracks.files > 0).then_some(TidyStep::Silent),
            (!categories.is_empty()).then_some(TidyStep::Convert),
        ];
        for step in steps.into_iter().flatten() {
            // Paused between steps, it waits here; stopped, what ran stays, with its one Undo.
            if progress.checkpoint().is_err() {
                tidied.notes.push("Stopped".to_owned());
                break;
            }
            let request = match step {
                TidyStep::Cleanup => PlanRequest::Cleanup { root_id },
                TidyStep::Silent => {
                    // Listed from what Clean up left.
                    let ids = inner
                        .catalog
                        .blocking(move |connection| silent_video_ids(connection, root_id))?;
                    if ids.is_empty() {
                        continue;
                    }
                    PlanRequest::StripAudio { file_ids: ids }
                }
                TidyStep::Convert => PlanRequest::Optimize {
                    root_id,
                    categories: categories.to_vec(),
                    file_ids: None,
                },
            };
            let planner = inner.clone();
            let kind = request.kind();
            let preview = inner
                .catalog
                .blocking(move |connection| planner.preview(connection, &request));
            let preview = match preview {
                Ok(preview) => preview,
                Err(error) => {
                    // A step with nothing left to do (its files went in an earlier step) is not
                    // an error.
                    let message = format!("{error:#}");
                    if !message.contains("nothing to do") {
                        tidied.notes.push(message);
                    }
                    continue;
                }
            };
            progress.phase(&doing_label(kind), 0);
            let applied = match inner.apply_locked(preview.plan_id, progress) {
                Ok(applied) => applied,
                Err(error) => {
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
        Ok(tidied)
    }

    // Follow-ups.

    /// Starts what a change left for the engine to do (see [`FollowUp`]) on a job of its own,
    /// or nothing when there is nothing to do: the scans as asked-for work, then the analysis in
    /// the background, as glazier-core queues them.
    pub fn start_follow_up(
        &self,
        follow_up: FollowUp,
        cx: &mut App,
    ) -> Option<Entity<Job<FollowUpReport>>> {
        if follow_up.is_empty() {
            return None;
        }
        let engine = self.clone();
        Some(Job::start(
            "Checking the changed files",
            cx,
            move |reporter: JobReporter| {
                on_thread("tidy follow-up", move || {
                    engine.follow_up_blocking(&follow_up, &reporter)
                })
            },
        ))
    }

    /// [`TidyEngine::start_follow_up`]'s work, on the calling thread: the scans first, as
    /// asked-for work, then in the background the analysis they and the change call for, of each
    /// root whose files need it with background analysis on.
    pub fn follow_up_blocking(
        &self,
        follow_up: &FollowUp,
        progress: &dyn Progress,
    ) -> anyhow::Result<FollowUpReport> {
        let mut report = FollowUpReport::default();
        let roots: HashSet<RootId> = self
            .inner
            .catalog
            .blocking(|connection| list_roots(connection))?
            .into_iter()
            .map(|root| root.id)
            .collect();
        let mut analyze: Vec<RootId> = Vec::new();
        for &root_id in &follow_up.rescan {
            if roots.contains(&root_id) {
                let scanned = self.scan_blocking(root_id, progress)?;
                report.scanned.push(root_id);
                analyze.extend(scanned.follow_up.analyze);
            }
        }
        for &root_id in &follow_up.analyze {
            if roots.contains(&root_id)
                && !report.scanned.contains(&root_id)
                && self.inner.analysis_due(root_id)?
            {
                analyze.push(root_id);
            }
        }
        for root_id in analyze {
            if !report.analyzed.contains(&root_id) {
                self.analyze_in_background_blocking(root_id, progress)?;
                report.analyzed.push(root_id);
            }
        }
        Ok(report)
    }
}

/// Tidy up's steps, in the order they run.
#[derive(Clone, Copy)]
enum TidyStep {
    Cleanup,
    Silent,
    Convert,
}

/// Every video of a root measured as silent, as the renderer's `silentVideoIds` lists them.
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
        let folder = std::env::temp_dir().join(format!(
            "oriel-tidy-estimate-{}-{}",
            std::process::id(),
            crate::catalog::now_ms()
        ));
        if fs::create_dir_all(&folder).is_err() {
            return unchanged;
        }
        let quiet = Quiet::new();
        let ratio = |index: usize, candidate: &crate::optimize::OptimizeCandidate| {
            let source = candidate.record.abs_path();
            let extension = Path::new(&candidate.target_name)
                .extension()
                .map(|extension| format!(".{}", extension.to_string_lossy()))
                .unwrap_or_default();
            let out = folder.join(format!("{index}{extension}"));
            let converted = self.convert_sample(candidate, &source, &out, quality, &quiet);
            converted
                .ok()
                .and_then(|()| fs::metadata(&out).ok())
                .map(|written| written.len() as f64 / (candidate.record.size.max(1)) as f64)
        };
        // A still's encode runs on one thread, so the eight run at once, within the memory
        // Convert's encodes may hold; ffmpeg's conversions use every core already, so they run
        // one after another. The ratios are sorted, so the order they come in changes nothing.
        let mut ratios: Vec<f64> = if category == OptimizeCategory::StillToAvif {
            let budget = EncodeBudget::for_this_machine();
            let (budget, quiet) = (&budget, &quiet);
            std::thread::scope(|scope| {
                let runs: Vec<_> = sample
                    .iter()
                    .enumerate()
                    .map(|(index, candidate)| {
                        scope.spawn(move || {
                            let pixels = candidate
                                .record
                                .width
                                .zip(candidate.record.height)
                                .map(|(width, height)| (width.max(0) * height.max(0)) as u64);
                            let _memory = budget.reserve(pixels, quiet).ok()?;
                            ratio(index, candidate)
                        })
                    })
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
        let _ = fs::remove_dir_all(&folder);
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

    fn convert_sample(
        &self,
        candidate: &crate::optimize::OptimizeCandidate,
        source: &Path,
        out: &PathBuf,
        quality: VideoQuality,
        quiet: &Quiet,
    ) -> anyhow::Result<()> {
        match candidate.category {
            OptimizeCategory::StillToAvif => {
                let vips = self.media.loaded_vips().context("no libvips")?;
                encode_still_to_avif(vips, Libavif::get()?, source, out)?;
            }
            OptimizeCategory::AnimationToMp4 => {
                let ffmpeg = self.media.ffmpeg.as_deref().context("no ffmpeg")?;
                transcode_with_ffmpeg(
                    ffmpeg,
                    &TranscodeJob::Animation { src: source, out },
                    Some(quiet.token()),
                )
                .map_err(|failure| anyhow::anyhow!("{failure}"))?;
            }
            OptimizeCategory::VideoRemux | OptimizeCategory::VideoConvert => {
                let ffmpeg = self.media.ffmpeg.as_deref().context("no ffmpeg")?;
                let (video, audio) = candidate.tracks.context("no tracks")?;
                transcode_with_ffmpeg(
                    ffmpeg,
                    &TranscodeJob::Video {
                        src: source,
                        out,
                        video,
                        audio,
                        quality,
                    },
                    Some(quiet.token()),
                )
                .map_err(|failure| anyhow::anyhow!("{failure}"))?;
            }
            OptimizeCategory::RenameAvif | OptimizeCategory::RenameMp4 => {}
        }
        Ok(())
    }
}
