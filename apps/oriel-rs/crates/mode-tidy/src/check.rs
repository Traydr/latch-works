//! Variables that set Tidy up for a check in a real window, since this Mac allows no scripted
//! input (the runbook lists them with the shell's):
//!
//! - `ORIEL_RS_TIDY_ROOT=<folder>` adds the folder as a root, if it is not one yet, shows it and
//!   scans it;
//! - `ORIEL_RS_TIDY_PAGE=<page>` opens a page by its `oriel.tidy.view` name (`overview`,
//!   `duplicates`, `convert`, `cleanup`, `shrink`, `library`, `history`, `holding`), and
//!   `duplicates:identical` opens Duplicates on its identical copies;
//! - `ORIEL_RS_QUICK_LOOK=<file>` shows the file in Quick Look once Tidy is up;
//! - `ORIEL_RS_TIDY_PICKER=1` opens the folder picker (Add Folder…) once Tidy is up.

use std::path::{Path, PathBuf};

use gpui_kit::{Context, Entity, Subscription, Window};

use crate::TidyMode;
use crate::pages::TidyPage;
use crate::state::TidyState;

pub const ROOT_VARIABLE: &str = "ORIEL_RS_TIDY_ROOT";
pub const PAGE_VARIABLE: &str = "ORIEL_RS_TIDY_PAGE";
pub const QUICK_LOOK_VARIABLE: &str = "ORIEL_RS_QUICK_LOOK";
pub const PICKER_VARIABLE: &str = "ORIEL_RS_TIDY_PICKER";

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
    if page.is_none() && root.is_none() && look.is_none() && !picker {
        return None;
    }
    let mut pending = Some((page, root));
    let mut overlays = Some((look, picker));
    Some(cx.observe_in(state, window, move |_, state, window, cx| {
        if !state.read(cx).is_ready() {
            return;
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
            if identical {
                state.open_duplicates(oriel_core_tidy::contract::DuplicateScope::Exact, cx);
            }
        });
    }))
}
