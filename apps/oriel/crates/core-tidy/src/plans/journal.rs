//! The journal, from the history half of glazier-core's `plans/executor.ts`: every plan with its
//! steps as History lists them, what each plan is about, and plans a crash left mid-change.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use super::planner::StepSpec;
use super::wording::{PlanSubject, plan_title};
use crate::catalog::rows::to_absolute_path;
use crate::contract::{
    HeldCount, HoldingId, PlanId, PlanKind, PlanListRequest, PlanStatus, PlanStep, PlanStepAction,
    PlanStepPage, PlanStepsRequest, PlanSummary, RootId, StepStatus,
};

/// A stored step with its root's path, as the executor reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct StepRecord {
    pub id: i64,
    pub plan_id: PlanId,
    pub action: PlanStepAction,
    pub root_id: RootId,
    pub root_path: String,
    pub from_rel: String,
    pub to_abs: Option<String>,
    pub spec: StepSpec,
    pub expected_size: i64,
    pub expected_mtime_ms: f64,
    pub expected_ctime_ms: f64,
    pub status: StepStatus,
    pub message: Option<String>,
    pub bytes_before: i64,
    pub bytes_after: Option<i64>,
    pub holding_id: Option<HoldingId>,
}

impl StepRecord {
    pub fn from_abs(&self) -> std::path::PathBuf {
        to_absolute_path(&self.root_path, &self.from_rel)
    }
}

pub const STEP_COLUMNS: &str = "s.id, s.plan_id, s.action, s.root_id, r.path AS root_path, \
  s.from_rel, s.to_abs, s.spec, s.expected_size, s.expected_mtime_ms, s.expected_ctime_ms, \
  s.status, s.message, s.bytes_before, s.bytes_after, s.holding_id";

fn invalid(index: usize, text: &str) -> rusqlite::Error {
    crate::catalog::rows::invalid_text(index, text)
}

pub fn step_record(row: &Row<'_>) -> rusqlite::Result<StepRecord> {
    let action: String = row.get(2)?;
    let spec: String = row.get(7)?;
    let status: String = row.get(11)?;
    Ok(StepRecord {
        id: row.get(0)?,
        plan_id: row.get(1)?,
        action: PlanStepAction::parse(&action).ok_or_else(|| invalid(2, &action))?,
        root_id: row.get(3)?,
        root_path: row.get(4)?,
        from_rel: row.get(5)?,
        to_abs: row.get(6)?,
        spec: serde_json::from_str(&spec).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, error.into())
        })?,
        expected_size: row.get(8)?,
        expected_mtime_ms: row.get(9)?,
        expected_ctime_ms: row.get(10)?,
        status: StepStatus::parse(&status).ok_or_else(|| invalid(11, &status))?,
        message: row.get(12)?,
        bytes_before: row.get(13)?,
        bytes_after: row.get(14)?,
        holding_id: row.get(15)?,
    })
}

/// A plan's steps in one status, by id in `order` ("ASC" or "DESC").
pub fn load_steps(
    connection: &Connection,
    plan_id: PlanId,
    status: StepStatus,
    descending: bool,
) -> anyhow::Result<Vec<StepRecord>> {
    let order = if descending { "DESC" } else { "ASC" };
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {STEP_COLUMNS} FROM plan_steps s JOIN roots r ON r.id = s.root_id
      WHERE s.plan_id = ?1 AND s.status = ?2 ORDER BY s.id {order}"
    ))?;
    let rows = statement.query_map(params![plan_id, status.as_str()], step_record)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A plan as the summary query adds it up.
struct PlanRow {
    id: PlanId,
    kind: PlanKind,
    created_at: i64,
    status: PlanStatus,
    count: i64,
    steps: i64,
    done: Option<i64>,
    skipped: Option<i64>,
    failed: Option<i64>,
    undone: Option<i64>,
    bytes_before: Option<i64>,
    bytes_after: Option<i64>,
    held_files: Option<i64>,
    held_bytes: Option<i64>,
    first_from: Option<String>,
}

const PLAN_SUMMARY_SQL: &str = "SELECT p.id, p.kind, p.created_at, p.status, p.count,
    COUNT(s.id) AS steps, SUM(s.status = 'done') AS done, SUM(s.status = 'skipped') AS skipped,
    SUM(s.status = 'failed') AS failed, SUM(s.status = 'undone') AS undone,
    SUM(CASE WHEN s.status = 'done' THEN s.bytes_before ELSE 0 END) AS bytes_before,
    SUM(CASE WHEN s.status = 'done' THEN COALESCE(s.bytes_after, 0) ELSE 0 END) AS bytes_after,
    SUM(s.status = 'done' AND s.holding_id IS NOT NULL) AS held_files,
    SUM(CASE WHEN s.status = 'done' AND s.holding_id IS NOT NULL THEN s.bytes_before ELSE 0 END)
      AS held_bytes,
    MIN(s.from_rel) AS first_from
  FROM plans p LEFT JOIN plan_steps s ON s.plan_id = p.id";

fn plan_row(row: &Row<'_>) -> rusqlite::Result<PlanRow> {
    let kind: String = row.get(1)?;
    let status: String = row.get(3)?;
    Ok(PlanRow {
        id: row.get(0)?,
        kind: PlanKind::parse(&kind).ok_or_else(|| invalid(1, &kind))?,
        created_at: row.get(2)?,
        status: PlanStatus::parse(&status).ok_or_else(|| invalid(3, &status))?,
        count: row.get(4)?,
        steps: row.get(5)?,
        done: row.get(6)?,
        skipped: row.get(7)?,
        failed: row.get(8)?,
        undone: row.get(9)?,
        bytes_before: row.get(10)?,
        bytes_after: row.get(11)?,
        held_files: row.get(12)?,
        held_bytes: row.get(13)?,
        first_from: row.get(14)?,
    })
}

/// Plan kinds whose `count` is their steps, so a partial run can say how many finished.
fn counts_steps(kind: PlanKind) -> bool {
    !matches!(
        kind,
        PlanKind::ResolveDuplicates | PlanKind::RemoveEmptyFolders
    )
}

fn base_of(rel_path: &str) -> &str {
    rel_path.rsplit('/').next().unwrap_or(rel_path)
}

fn subject_of(
    kind: PlanKind,
    count: i64,
    first_from: Option<&str>,
    status: PlanStatus,
    done: Option<i64>,
) -> PlanSubject {
    let done = done.unwrap_or(0);
    let cut_short = matches!(
        status,
        PlanStatus::Partial | PlanStatus::Failed | PlanStatus::Cancelled
    ) && counts_steps(kind)
        && done < count;
    PlanSubject {
        kind,
        count,
        single_name: first_from.map(|from| base_of(from).to_owned()),
        finished: cut_short.then_some(done),
    }
}

fn summary_of(row: PlanRow) -> PlanSummary {
    let subject = subject_of(
        row.kind,
        row.count,
        row.first_from.as_deref(),
        row.status,
        row.done,
    );
    PlanSummary {
        id: row.id,
        kind: row.kind,
        created_at: row.created_at,
        status: row.status,
        title: plan_title(&subject),
        count: row.count,
        steps: row.steps,
        done: row.done.unwrap_or(0),
        skipped: row.skipped.unwrap_or(0),
        failed: row.failed.unwrap_or(0),
        undone: row.undone.unwrap_or(0),
        bytes_before: row.bytes_before.unwrap_or(0),
        bytes_after: row.bytes_after.unwrap_or(0),
        held: HeldCount {
            files: row.held_files.unwrap_or(0),
            bytes: row.held_bytes.unwrap_or(0),
        },
    }
}

/// Every plan but drafts, newest first, of a root (any plan with a step in it) or of every root.
pub fn list_plans(
    connection: &Connection,
    request: &PlanListRequest,
) -> anyhow::Result<Vec<PlanSummary>> {
    let root_filter = if request.root_id.is_some() {
        "AND p.id IN (SELECT plan_id FROM plan_steps WHERE root_id = ?3)"
    } else {
        ""
    };
    let sql = format!(
        "{PLAN_SUMMARY_SQL}
      WHERE p.status != 'draft' {root_filter}
      GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC LIMIT ?1 OFFSET ?2"
    );
    let mut statement = connection.prepare_cached(&sql)?;
    let rows = match request.root_id {
        Some(root_id) => {
            statement.query_map(params![request.limit, request.offset, root_id], plan_row)?
        }
        None => statement.query_map(params![request.limit, request.offset], plan_row)?,
    };
    Ok(rows
        .map(|row| row.map(summary_of))
        .collect::<rusqlite::Result<_>>()?)
}

/// One plan, whatever its status, or `None` when there is no such plan.
pub fn get_plan(connection: &Connection, plan_id: PlanId) -> anyhow::Result<Option<PlanSummary>> {
    Ok(connection
        .query_row(
            &format!("{PLAN_SUMMARY_SQL} WHERE p.id = ?1 GROUP BY p.id"),
            [plan_id],
            plan_row,
        )
        .optional()?
        .map(summary_of))
}

/// What a plan is about, for its title and job labels.
pub fn plan_subject(
    connection: &Connection,
    plan_id: PlanId,
) -> anyhow::Result<Option<PlanSubject>> {
    let row = connection
        .query_row(
            "SELECT p.kind, p.count, p.status, MIN(s.from_rel) AS first_from,
          SUM(s.status = 'done') AS done
        FROM plans p LEFT JOIN plan_steps s ON s.plan_id = p.id WHERE p.id = ?1 GROUP BY p.id",
            [plan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(kind, count, status, first_from, done)| {
        Some(subject_of(
            PlanKind::parse(&kind)?,
            count,
            first_from.as_deref(),
            PlanStatus::parse(&status)?,
            done,
        ))
    }))
}

/// One page of a plan's steps, in the order they were planned.
pub fn list_plan_steps(
    connection: &Connection,
    request: &PlanStepsRequest,
) -> anyhow::Result<PlanStepPage> {
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) AS total FROM plan_steps WHERE plan_id = ?1",
        [request.plan_id],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {STEP_COLUMNS} FROM plan_steps s JOIN roots r ON r.id = s.root_id
      WHERE s.plan_id = ?1 ORDER BY s.id LIMIT ?2 OFFSET ?3"
    ))?;
    let rows = statement.query_map(
        params![request.plan_id, request.limit, request.offset],
        step_record,
    )?;
    let steps = rows
        .map(|row| {
            row.map(|step| PlanStep {
                id: step.id,
                action: step.action,
                from_path: step.from_abs().to_string_lossy().into_owned(),
                to_path: step.to_abs.clone(),
                status: step.status,
                message: step.message.clone(),
                bytes_before: step.bytes_before,
                bytes_after: step.bytes_after,
            })
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(PlanStepPage { total, steps })
}

/// Forgets a draft the owner chose not to apply; a plan past its draft is history and stays.
pub fn discard_draft(connection: &Connection, plan_id: PlanId) -> anyhow::Result<()> {
    connection.execute(
        "DELETE FROM plans WHERE id = ?1 AND status = 'draft'",
        [plan_id],
    )?;
    Ok(())
}

/// The roots a plan has steps in.
pub fn plan_root_ids(connection: &Connection, plan_id: PlanId) -> anyhow::Result<Vec<RootId>> {
    let mut statement =
        connection.prepare_cached("SELECT DISTINCT root_id FROM plan_steps WHERE plan_id = ?1")?;
    let rows = statement.query_map([plan_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The temp file a conversion writes beside its target before it is checked and put in place.
pub fn temp_path_of(target: &str) -> String {
    format!("{target}.glazier-tmp")
}

/// After a crash or a quit mid-change, a plan can be left `applying` with temp files beside its
/// targets. Those plans become `cancelled` (so their finished steps can still be undone) and
/// their temp files are removed.
pub fn recover_interrupted_plans(connection: &Connection) -> anyhow::Result<usize> {
    let interrupted: Vec<PlanId> = {
        let mut statement = connection.prepare("SELECT id FROM plans WHERE status = 'applying'")?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    for &plan_id in &interrupted {
        let targets: Vec<String> = {
            let mut statement = connection.prepare(
                "SELECT to_abs FROM plan_steps
          WHERE plan_id = ?1 AND status = 'pending' AND to_abs IS NOT NULL",
            )?;
            statement
                .query_map([plan_id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for target in targets {
            let _ = std::fs::remove_file(Path::new(&temp_path_of(&target)));
        }
        connection.execute(
            "UPDATE plans SET status = 'cancelled' WHERE id = ?1",
            [plan_id],
        )?;
    }
    Ok(interrupted.len())
}
