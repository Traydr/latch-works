//! Variables that set Tidy up for a check in a real window, since this Mac allows no scripted
//! input (the runbook lists them with the shell's):
//!
//! - `ORIEL_RS_TIDY_ROOT=<folder>` adds the folder as a root, if it is not one yet, shows it and
//!   scans it;
//! - `ORIEL_RS_TIDY_PAGE=<page>` opens a page by its `oriel.tidy.view` name (`overview`,
//!   `duplicates`, `convert`, `cleanup`, `shrink`, `library`, `history`, `holding`).

use std::path::{Path, PathBuf};

use gpui_kit::{Context, Entity, Subscription, Window};

use crate::TidyMode;
use crate::pages::TidyPage;
use crate::state::TidyState;

pub const ROOT_VARIABLE: &str = "ORIEL_RS_TIDY_ROOT";
pub const PAGE_VARIABLE: &str = "ORIEL_RS_TIDY_PAGE";

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Applies the variables once the engine is open; the subscription ends with the mode.
pub fn apply_from_environment(
    state: &Entity<TidyState>,
    window: &mut Window,
    cx: &mut Context<TidyMode>,
) -> Option<Subscription> {
    let page = variable(PAGE_VARIABLE).and_then(|key| TidyPage::from_key(&key));
    let root = variable(ROOT_VARIABLE).map(PathBuf::from);
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
                let resolved = std::fs::canonicalize(&root).unwrap_or(root);
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
        });
    }))
}
