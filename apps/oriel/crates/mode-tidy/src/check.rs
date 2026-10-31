//! Variables that set Tidy up for a check in a real window, since this Mac allows no scripted
//! input (the runbook lists them with the shell's):
//!
//! - `ORIEL_TIDY_ROOT=<folder>` adds the folder as a root, if it is not one yet, shows it and
//!   scans it;
//! - `ORIEL_TIDY_PAGE=<page>` opens a page by its `oriel.tidy.view` name (`overview`,
//!   `duplicates`, `convert`, `cleanup`, `shrink`, `library`, `history`, `holding`), and
//!   `duplicates:identical` opens Duplicates on its identical copies;
//! - `ORIEL_QUICK_LOOK=<file>` shows the file in Quick Look once Tidy is up;
//! - `ORIEL_TIDY_PICKER=1` opens the folder picker (Add Folder…) once Tidy is up;
//! - `ORIEL_TIDY_RUN=convert,cleanup` starts those pages' changes, one after another as the
//!   pages' buttons would, once the folder on screen is scanned: the second queues behind the
//!   first, to see the activity panel with work running and waiting. It changes the folder's
//!   files, so point it only at a copy.

use std::path::{Path, PathBuf};

use gpui_kit::{Context, Entity, Subscription, Window};

use crate::TidyMode;
use crate::pages::TidyPage;
use crate::state::TidyState;

pub const ROOT_VARIABLE: &str = "ORIEL_TIDY_ROOT";
pub const PAGE_VARIABLE: &str = "ORIEL_TIDY_PAGE";
pub const QUICK_LOOK_VARIABLE: &str = "ORIEL_QUICK_LOOK";
pub const PICKER_VARIABLE: &str = "ORIEL_TIDY_PICKER";
pub const RUN_VARIABLE: &str = "ORIEL_TIDY_RUN";

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Applies the variables once the engine is open; the subscription ends with the mode.
pub fn apply_from_environment(
    state: &Entity<TidyState>,
    window: &mut Window,
    cx: &mut Context<TidyMode>,
) -> Option<Subscription> {
    let asked = variable(PAGE_VARIABLE);
    let identical = asked.as_deref() == Some("duplicates:identical");
    let page = asked.and_then(|key| TidyPage::from_key(key.split(':').next().unwrap_or("")));
    let root = variable(ROOT_VARIABLE).map(PathBuf::from);
    let look = variable(QUICK_LOOK_VARIABLE).map(PathBuf::from);
    let picker = variable(PICKER_VARIABLE).is_some();
    let runs: Vec<String> = variable(RUN_VARIABLE)
        .map(|runs| runs.split(',').map(|run| run.trim().to_owned()).collect())
        .unwrap_or_default();
    if page.is_none() && root.is_none() && look.is_none() && !picker && runs.is_empty() {
        return None;
    }
    let mut pending = Some((page, root));
    let mut overlays = Some((look, picker));
    let mut runs = Some(runs).filter(|runs| !runs.is_empty());
    Some(cx.observe_in(state, window, move |_, state, window, cx| {
        if !state.read(cx).is_ready() {
            return;
        }
        // Once the scan and its analysis are done and the numbers read again show work.
        let scanned = {
            let state = state.read(cx);
            !state.is_busy()
                && state.root().is_some_and(|root| root.last_scan_at.is_some())
                && state.overview().is_some_and(|tidy| {
                    crate::sidebar::convert_count(tidy) + crate::sidebar::cleanup_count(tidy) > 0
                })
        };
        if scanned && let Some(runs) = runs.take() {
            state.update(cx, |state, cx| start_runs(state, &runs, window, cx));
        }
        // Once the window has drawn, so the panel and the picker have something to sit over.
        if let Some((look, picker)) = overlays.take() {
            let state = state.clone();
            cx.defer_in(window, move |_, window, cx| {
                if let Some(look) = look {
                    crate::quick_look::quick_look(&look, window, cx);
                }
                if picker {
                    crate::open_add_folder(&state, window, cx);
                }
            });
        }
        let Some((page, root)) = pending.take() else {
            return;
        };
        state.update(cx, |state, cx| {
            if let Some(page) = page {
                state.go(page, cx);
            }
            if let Some(root) = root {
                let resolved = oriel_runtime::paths::canonicalize(&root).unwrap_or(root);
                let known = state
                    .roots()
                    .iter()
                    .find(|known| Path::new(&known.path) == resolved)
                    .map(|known| known.id);
                match known {
                    Some(root_id) => state.select_root(root_id, cx),
                    None => state.add_folder(resolved, window, cx),
                }
                if let Some(page) = page {
                    state.go(page, cx);
                }
            }
            if identical {
                state.open_duplicates(oriel_core_tidy::contract::DuplicateScope::Exact, cx);
            }
        });
    }))
}

/// Starts the changes `ORIEL_TIDY_RUN` names on the folder on screen, as their pages would.
fn start_runs(
    state: &mut TidyState,
    runs: &[String],
    window: &mut Window,
    cx: &mut Context<TidyState>,
) {
    use crate::actions::PerformOptions;
    use crate::changes::PlanRequest;
    let Some(root_id) = state.root_id() else {
        return;
    };
    for run in runs {
        let (request, source) = match run.as_str() {
            "convert" => (
                PlanRequest::Optimize {
                    root_id,
                    categories: state.convert_categories(),
                    file_ids: None,
                },
                "convert",
            ),
            "cleanup" => (PlanRequest::Cleanup { root_id }, "cleanup"),
            _ => continue,
        };
        state.perform(request, PerformOptions::from(source), window, cx);
    }
}
