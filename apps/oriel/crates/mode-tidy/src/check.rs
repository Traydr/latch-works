//! Variables that set Tidy up for a check in a real window, since this Mac allows no scripted
//! input (the runbook lists them with the shell's):
//!
//! - `ORIEL_TIDY_ROOT=<folder>` adds the folder as a root, if it is not one yet, shows it and
//!   scans it;
//! - `ORIEL_TIDY_PAGE=<page>` opens a page by its `oriel.tidy.view` name (`overview`,
//!   `duplicates`, `convert`, `cleanup`, `shrink`, `library`, `history`, `holding`), and
//!   `duplicates:identical` and `duplicates:variants` open Duplicates on those sets;
//! - `ORIEL_QUICK_LOOK=<file>` shows the file in Quick Look once Tidy is up;
//! - `ORIEL_TIDY_PICKER=1` opens the folder picker (Add Folder…) once Tidy is up;
//! - `ORIEL_TIDY_SHORTCUTS=1` opens the keyboard shortcuts once Tidy is up;
//! - `ORIEL_TIDY_MOVE=1` opens the folder picker a Move to… opens, once Tidy is up;
//! - `ORIEL_TIDY_FORGET=1` asks whether to forget the folder on screen once Tidy is up;
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
pub const SHORTCUTS_VARIABLE: &str = "ORIEL_TIDY_SHORTCUTS";
pub const FORGET_VARIABLE: &str = "ORIEL_TIDY_FORGET";
pub const MOVE_VARIABLE: &str = "ORIEL_TIDY_MOVE";
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
    let scope = match asked.as_deref() {
        Some("duplicates:identical") => Some(oriel_core_tidy::contract::DuplicateScope::Exact),
        Some("duplicates:variants") => Some(oriel_core_tidy::contract::DuplicateScope::Variants),
        _ => None,
    };
    let page = asked.and_then(|key| TidyPage::from_key(key.split(':').next().unwrap_or("")));
    let root = variable(ROOT_VARIABLE).map(PathBuf::from);
    let look = variable(QUICK_LOOK_VARIABLE).map(PathBuf::from);
    let picker = variable(PICKER_VARIABLE).is_some();
    let shortcuts = variable(SHORTCUTS_VARIABLE).is_some();
    let forget = variable(FORGET_VARIABLE).is_some();
    let move_to = variable(MOVE_VARIABLE).is_some();
    let runs: Vec<String> = variable(RUN_VARIABLE)
        .map(|runs| runs.split(',').map(|run| run.trim().to_owned()).collect())
        .unwrap_or_default();
    if page.is_none()
        && root.is_none()
        && look.is_none()
        && !picker
        && !shortcuts
        && !forget
        && !move_to
        && runs.is_empty()
    {
        return None;
    }
    let mut pending = Some((page, root));
    let mut overlays = Some((look, picker, shortcuts, forget, move_to));
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
        if let Some((look, picker, shortcuts, forget, move_to)) = overlays.take() {
            let state = state.clone();
            cx.defer_in(window, move |_, window, cx| {
                if let Some(look) = look {
                    crate::quick_look::quick_look(&look, window, cx);
                }
                if picker {
                    crate::open_add_folder(&state, window, cx);
                }
                if shortcuts {
                    crate::shortcuts::open(window, cx);
                }
                if move_to && let Some(root) = state.read(cx).root().cloned() {
                    let options = crate::folder_picker::PickOptions {
                        title: "Move 3 files to".into(),
                        action: "Move to".into(),
                        start: None,
                        select: None,
                        within: Some((root.path.clone().into(), root.name.clone())),
                        sandbox: None,
                    };
                    crate::folder_picker::open(options, window, cx, |_, _, _| {});
                }
                if forget && let Some(root) = state.read(cx).root().cloned() {
                    crate::sidebar::confirm_forget(&state, root.id, root.name, window, cx);
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
            if let Some(scope) = scope {
                state.open_duplicates(scope, cx);
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
