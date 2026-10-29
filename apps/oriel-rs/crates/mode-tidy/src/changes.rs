//! Tidy's changes to files, behind one seam: [`TidyChanges`] has exactly glazier-core's engine
//! methods that change the archive or read the record of changes (`contract.ts`,
//! `EngineMethods`), in snake case, with the contract's values as `oriel-core-tidy` defines them,
//! and every page's change actions go through it. Each method is handed the engine the pages
//! read from, so an implementation needs nothing of its own.
//!
//! Two differences follow from GPUI rather than from the contract:
//!
//! - `perform`, `apply_plan` and `undo_plan` answer with an `oriel-runtime` [`Job`], as the
//!   engine's scans do, whose value is what the change did ([`Applied`], [`Undone`]): the plan as
//!   it finished, and the roots to scan or analyse again.
//! - [`TidyChanges::empty_holding`] is Electron Oriel's main-process `emptyHolding`: the root's
//!   holding batches to the Trash, then marked emptied.
//!
//! [`NotYet`] answers every method with "not available yet", so the pages run before the
//! executor is trusted with files; [`EngineChanges`] passes each call to the engine's executor.
//! The app chooses which (`TidyMode::new` takes [`NotYet`]).

use std::rc::Rc;
use std::sync::Arc;

use futures::future::BoxFuture;
use gpui_kit::{App, Entity, Task};
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{OptimizeCategory, RootId};
use oriel_runtime::Job;

pub use oriel_core_tidy::contract::{
    EmptyHoldingResult, HoldingId, HoldingItem, HoldingList, HoldingRequest, OptimizeEstimate,
    PlanId, PlanKind, PlanListRequest, PlanPreview, PlanRequest, PlanStatus, PlanStep,
    PlanStepAction, PlanStepPage, PlanStepsRequest, PlanSummary, Rename, ResolveGroup,
    RestoreResult, StepStatus, VideoCodecChoice,
};
pub use oriel_core_tidy::{Applied, FollowUp, Undone};

/// What every method answers until the executor is in: the pages show it as their error, the
/// actions as a toast.
pub const NOT_YET: &str = "Oriel RS can't change files yet: Tidy's executor is still being ported.";

/// A future the pages await on GPUI's executors.
pub type Answer<T> = BoxFuture<'static, anyhow::Result<T>>;

/// What `perform` answers: the plan as drafted, and the job applying it.
pub type Performing = Task<anyhow::Result<(PlanPreview, Entity<Job<Applied>>)>>;

/// glazier-core's engine methods that change files or read the record of changes.
pub trait TidyChanges {
    /// `estimateOptimize`: converts a small sample of a category to estimate its result.
    fn estimate_optimize(
        &self,
        engine: &TidyEngine,
        root_id: RootId,
        category: OptimizeCategory,
    ) -> Answer<OptimizeEstimate>;
    /// `previewPlan`: drafts a plan without applying it.
    fn preview_plan(&self, engine: &TidyEngine, request: PlanRequest) -> Answer<PlanPreview>;
    /// `perform`: drafts a plan and applies it at once. Its warnings never hold it back, since it
    /// can be undone.
    fn perform(&self, engine: &TidyEngine, request: PlanRequest, cx: &mut App) -> Performing;
    /// `applyPlan`: applies a drafted plan.
    fn apply_plan(
        &self,
        engine: &TidyEngine,
        plan_id: PlanId,
        cx: &mut App,
    ) -> Entity<Job<Applied>>;
    /// `discardPlan`: forgets a drafted plan.
    fn discard_plan(&self, engine: &TidyEngine, plan_id: PlanId) -> Answer<()>;
    /// `listPlans`: the journal, newest first.
    fn list_plans(&self, engine: &TidyEngine, request: PlanListRequest)
    -> Answer<Vec<PlanSummary>>;
    /// `getPlan`.
    fn get_plan(&self, engine: &TidyEngine, plan_id: PlanId) -> Answer<PlanSummary>;
    /// `planSteps`: a plan's steps, in order.
    fn plan_steps(&self, engine: &TidyEngine, request: PlanStepsRequest) -> Answer<PlanStepPage>;
    /// `undoPlan`: puts back what a plan's finished steps did.
    fn undo_plan(&self, engine: &TidyEngine, plan_id: PlanId, cx: &mut App) -> Entity<Job<Undone>>;
    /// `listHolding`: a root's held files, newest first.
    fn list_holding(&self, engine: &TidyEngine, request: HoldingRequest) -> Answer<HoldingList>;
    /// `restoreHolding`: held files back where they were.
    fn restore_holding(&self, engine: &TidyEngine, ids: Vec<HoldingId>) -> Answer<RestoreResult>;
    /// `holdingBatches`: the folders a root's held files sit in, for the Trash.
    fn holding_batches(&self, engine: &TidyEngine, root_id: RootId) -> Answer<Vec<String>>;
    /// `markHoldingEmptied`: records that these batches went to the Trash.
    fn mark_holding_emptied(
        &self,
        engine: &TidyEngine,
        root_id: RootId,
        batch_paths: Vec<String>,
    ) -> Answer<i64>;
    /// Electron Oriel's `emptyHolding`: [`Self::holding_batches`] to the Trash, then
    /// [`Self::mark_holding_emptied`] for those that went.
    fn empty_holding(&self, engine: &TidyEngine, root_id: RootId) -> Answer<EmptyHoldingResult>;
}

/// The changes as the pages hold them.
pub type Changes = Rc<dyn TidyChanges>;

/// [`NotYet`]'s error, so a caller can tell "not ported yet" from a change that failed.
#[derive(Clone, Copy, Debug)]
pub struct NotAvailable;

impl std::fmt::Display for NotAvailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(NOT_YET)
    }
}

impl std::error::Error for NotAvailable {}

/// Whether `error` is [`NotYet`]'s answer.
pub fn is_not_yet(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<NotAvailable>())
}

/// Answers every method with [`NOT_YET`], so the pages run before the executor is trusted.
#[derive(Clone, Copy, Debug, Default)]
pub struct NotYet;

fn not_yet<T: Send + 'static>() -> Answer<T> {
    Box::pin(async { Err(anyhow::Error::new(NotAvailable)) })
}

fn failing_job<T: Send + 'static>(name: &'static str, cx: &mut App) -> Entity<Job<T>> {
    Job::start(name, cx, |_| async {
        Err(anyhow::Error::new(NotAvailable))
    })
}

impl TidyChanges for NotYet {
    fn estimate_optimize(
        &self,
        _: &TidyEngine,
        _: RootId,
        _: OptimizeCategory,
    ) -> Answer<OptimizeEstimate> {
        not_yet()
    }

    fn preview_plan(&self, _: &TidyEngine, _: PlanRequest) -> Answer<PlanPreview> {
        not_yet()
    }

    fn perform(&self, _: &TidyEngine, _: PlanRequest, _: &mut App) -> Performing {
        Task::ready(Err(anyhow::Error::new(NotAvailable)))
    }

    fn apply_plan(&self, _: &TidyEngine, _: PlanId, cx: &mut App) -> Entity<Job<Applied>> {
        failing_job("Changing files", cx)
    }

    fn discard_plan(&self, _: &TidyEngine, _: PlanId) -> Answer<()> {
        not_yet()
    }

    fn list_plans(&self, _: &TidyEngine, _: PlanListRequest) -> Answer<Vec<PlanSummary>> {
        not_yet()
    }

    fn get_plan(&self, _: &TidyEngine, _: PlanId) -> Answer<PlanSummary> {
        not_yet()
    }

    fn plan_steps(&self, _: &TidyEngine, _: PlanStepsRequest) -> Answer<PlanStepPage> {
        not_yet()
    }

    fn undo_plan(&self, _: &TidyEngine, _: PlanId, cx: &mut App) -> Entity<Job<Undone>> {
        failing_job("Undoing", cx)
    }

    fn list_holding(&self, _: &TidyEngine, _: HoldingRequest) -> Answer<HoldingList> {
        not_yet()
    }

    fn restore_holding(&self, _: &TidyEngine, _: Vec<HoldingId>) -> Answer<RestoreResult> {
        not_yet()
    }

    fn holding_batches(&self, _: &TidyEngine, _: RootId) -> Answer<Vec<String>> {
        not_yet()
    }

    fn mark_holding_emptied(&self, _: &TidyEngine, _: RootId, _: Vec<String>) -> Answer<i64> {
        not_yet()
    }

    fn empty_holding(&self, _: &TidyEngine, _: RootId) -> Answer<EmptyHoldingResult> {
        not_yet()
    }
}

/// Every call passed to the engine's executor (`oriel-core-tidy`'s `engine::changes`).
#[derive(Clone, Copy, Debug, Default)]
pub struct EngineChanges;

impl TidyChanges for EngineChanges {
    fn estimate_optimize(
        &self,
        engine: &TidyEngine,
        root_id: RootId,
        category: OptimizeCategory,
    ) -> Answer<OptimizeEstimate> {
        Box::pin(engine.estimate_optimize(root_id, category))
    }

    fn preview_plan(&self, engine: &TidyEngine, request: PlanRequest) -> Answer<PlanPreview> {
        Box::pin(engine.preview_plan(request))
    }

    fn perform(&self, engine: &TidyEngine, request: PlanRequest, cx: &mut App) -> Performing {
        engine.perform(request, cx)
    }

    fn apply_plan(
        &self,
        engine: &TidyEngine,
        plan_id: PlanId,
        cx: &mut App,
    ) -> Entity<Job<Applied>> {
        engine.start_apply(plan_id, cx)
    }

    fn discard_plan(&self, engine: &TidyEngine, plan_id: PlanId) -> Answer<()> {
        Box::pin(engine.discard_plan(plan_id))
    }

    fn list_plans(
        &self,
        engine: &TidyEngine,
        request: PlanListRequest,
    ) -> Answer<Vec<PlanSummary>> {
        Box::pin(engine.list_plans(request))
    }

    fn get_plan(&self, engine: &TidyEngine, plan_id: PlanId) -> Answer<PlanSummary> {
        Box::pin(engine.get_plan(plan_id))
    }

    fn plan_steps(&self, engine: &TidyEngine, request: PlanStepsRequest) -> Answer<PlanStepPage> {
        Box::pin(engine.plan_steps(request))
    }

    fn undo_plan(&self, engine: &TidyEngine, plan_id: PlanId, cx: &mut App) -> Entity<Job<Undone>> {
        engine.start_undo(plan_id, cx)
    }

    fn list_holding(&self, engine: &TidyEngine, request: HoldingRequest) -> Answer<HoldingList> {
        Box::pin(engine.list_holding(request))
    }

    fn restore_holding(&self, engine: &TidyEngine, ids: Vec<HoldingId>) -> Answer<RestoreResult> {
        Box::pin(engine.restore_holding(ids))
    }

    fn holding_batches(&self, engine: &TidyEngine, root_id: RootId) -> Answer<Vec<String>> {
        Box::pin(engine.holding_batches(root_id))
    }

    fn mark_holding_emptied(
        &self,
        engine: &TidyEngine,
        root_id: RootId,
        batch_paths: Vec<String>,
    ) -> Answer<i64> {
        Box::pin(engine.mark_holding_emptied(root_id, batch_paths))
    }

    fn empty_holding(&self, engine: &TidyEngine, root_id: RootId) -> Answer<EmptyHoldingResult> {
        Box::pin(engine.empty_holding(root_id))
    }
}

/// Whether a finished plan can be undone (`canUndo`).
pub fn can_undo(plan: &PlanSummary) -> bool {
    plan.can_undo()
}

/// A failure as a job reports it.
pub fn job_error(error: anyhow::Error) -> oriel_runtime::JobError {
    oriel_runtime::JobError::Failed(Arc::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The requests go out in the contract's JSON, so the two engines read the same changes.
    #[test]
    fn requests_serialize_as_the_contract_names_them() {
        let request = PlanRequest::ResolveDuplicates {
            groups: vec![ResolveGroup {
                keep: vec![1],
                remove: vec![2, 3],
            }],
        };
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"kind":"resolve-duplicates","groups":[{"keep":[1],"remove":[2,3]}]}"#
        );
        let request = PlanRequest::Optimize {
            root_id: 1,
            categories: vec![OptimizeCategory::StillToAvif],
            file_ids: None,
        };
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"kind":"optimize","rootId":1,"categories":["still-to-avif"],"fileIds":null}"#
        );
    }
}
