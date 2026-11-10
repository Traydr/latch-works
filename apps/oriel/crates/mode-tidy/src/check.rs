//! What a launch asks of Tidy for a check in a real window, from the two variables
//! `oriel_launch::variables` names, which `xtask measure` and the shell's spike set too:
//!
//! - `ORIEL_TIDY_ROOT=<folder>` adds the folder as a root, if it is not one yet, shows it and
//!   scans it;
//! - `ORIEL_TIDY_PAGE=<page>` opens a page by its `oriel.tidy.view` name (`overview`,
//!   `duplicates`, `convert`, `cleanup`, `shrink`, `library`, `history`, `holding`), and
//!   `duplicates:identical` and `duplicates:variants` open Duplicates on those sets.
//!
//! Everything else a check needs on Tidy's pages is input, which `ORIEL_SCRIPT` plays.

use std::path::{Path, PathBuf};

use gpui_kit::{Context, Entity, Subscription, Window};
use oriel_core_tidy::contract::DuplicateScope;
use oriel_launch::{Variables, variables};

use crate::TidyMode;
use crate::pages::TidyPage;
use crate::state::TidyState;

/// Everything a launch asks of Tidy for a check.
#[derive(Clone, Debug, Default)]
pub(crate) struct TidyChecks {
    root: Option<PathBuf>,
    page: Option<String>,
}

impl TidyChecks {
    pub(crate) fn from_variables(launch: &Variables) -> Self {
        Self {
            root: launch.get(variables::TIDY_ROOT).map(PathBuf::from),
            page: launch.get(variables::TIDY_PAGE).map(str::to_owned),
        }
    }
}

/// Applies `checks` once the engine is open; the subscription ends with the mode.
pub(crate) fn apply(
    checks: &TidyChecks,
    state: &Entity<TidyState>,
    window: &mut Window,
    cx: &mut Context<TidyMode>,
) -> Option<Subscription> {
    let asked = checks.page.as_deref();
    let scope = match asked {
        Some("duplicates:identical") => Some(DuplicateScope::Exact),
        Some("duplicates:variants") => Some(DuplicateScope::Variants),
        _ => None,
    };
    let page = asked.and_then(|key| TidyPage::from_key(key.split(':').next().unwrap_or("")));
    let root = checks.root.clone();
    if page.is_none() && root.is_none() {
        return None;
    }
    let mut pending = Some((page, root));
    Some(cx.observe_in(state, window, move |_, state, window, cx| {
        if !state.read(cx).is_ready() {
            return;
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
