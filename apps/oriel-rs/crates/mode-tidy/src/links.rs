//! What Tidy hands the other modes, and what it takes from them (Electron Oriel's
//! `useOpenInView`, Overview's Sync this folder, and `showHandOff`).
//!
//! The pages ask [`TidyState`] to open a file or folder in View, or to sync a folder; it emits a
//! [`TidyEvent`], which [`crate::TidyMode`] passes on to the shell. A file or folder another mode
//! hands Tidy is shown by [`take`]: at the Library, filtered to it, in the folder of Tidy's that
//! holds it. A folder no folder of Tidy's holds is added, once the owner agrees for a file's
//! folder. A folder picked in the location switcher's menu is [`offer`]ed. In a sandboxed run (`ORIEL_RS_DATA_DIR` set) only folders inside the sandbox can be,
//! so for any other Tidy says why instead.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::component::button::ButtonVariant;
use gpui_kit::{App, Entity, Window};
use oriel_core_paths::DataRoot;
use oriel_ui::folders::{closest_folder, relative_inside};
use oriel_ui::{HandOff, Toast};

use crate::state::{LibraryPreset, TidyState};
use crate::widgets;

/// What Tidy asks of the rest of the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TidyEvent {
    /// Open in View: a file opens in View's viewer once its folder is listed, a folder as it is
    /// (`handOff("view", …)`).
    OpenInView(PathBuf),
    /// Sync this folder: Sync shows the profile whose source holds it, or starts one for it.
    SyncFolder(PathBuf),
}

/// Shows `target`, which another mode handed Tidy (`showHandOff`). Call it once Tidy's engine
/// has listed its folders.
pub fn take(state: &Entity<TidyState>, target: HandOff, window: &mut Window, cx: &mut App) {
    // Tidy's folders are kept resolved, so the path handed over is resolved too.
    let target = match target {
        HandOff::File(path) => HandOff::File(resolved(path)),
        HandOff::Folder(path) => HandOff::Folder(resolved(path)),
    };
    let current = state.read(cx);
    let folder = target.folder().to_path_buf();
    let holder = closest_folder(current.roots(), &folder, |root| Path::new(&root.path)).cloned();
    if let Some(root) = holder {
        let dir = relative_inside(Path::new(&root.path), &folder).filter(|dir| !dir.is_empty());
        let search = match &target {
            HandOff::File(path) => file_name(path),
            HandOff::Folder(_) => String::new(),
        };
        state.update(cx, |state, cx| {
            state.select_root(root.id, cx);
            state.open_library(
                LibraryPreset {
                    dir,
                    search,
                    ..LibraryPreset::default()
                },
                cx,
            );
        });
        return;
    }

    let data = current.data().clone();
    if matches!(target, HandOff::Folder(_)) {
        if data.admits_tidy_root(&folder) {
            state.update(cx, |state, cx| state.add_folder(folder, window, cx));
        } else {
            explain_sandbox(&folder, &data, window, cx);
        }
        return;
    }

    // A file no folder of Tidy's holds: offer the outermost folder another mode uses that holds
    // it (the folder View was opened at, say), so Tidy does not add a small folder a later,
    // larger one would overlap. Tidy's folders never nest, so one that holds a folder of Tidy's
    // cannot be added.
    let holds_a_root = |candidate: &Path| {
        current
            .roots()
            .iter()
            .find(|root| relative_inside(candidate, Path::new(&root.path)).is_some())
            .map(|root| root.name.clone())
    };
    let outer = current
        .shell
        .read(cx)
        .known_folders()
        .iter()
        .map(|known| known.path())
        .filter(|known| {
            relative_inside(known, &folder).is_some()
                && holds_a_root(known).is_none()
                && data.admits_tidy_root(known)
        })
        .min_by_key(|known| known.as_os_str().len())
        .map(Path::to_path_buf);
    let candidate = outer.unwrap_or(folder);
    if let Some(name) = holds_a_root(&candidate) {
        widgets::show_toast(
            window,
            Toast::info("Tidy can't add this file's folder").detail(format!(
                "{} holds {name}, which Tidy already tidies, and Tidy's folders don't nest.",
                candidate.display()
            )),
            cx,
        );
        return;
    }
    if !data.admits_tidy_root(&candidate) {
        explain_sandbox(&candidate, &data, window, cx);
        return;
    }
    confirm_adding(
        state,
        candidate,
        Some("No folder Tidy tidies holds this file."),
        window,
        cx,
    );
}

/// A folder picked in the location switcher's menu, which another mode uses (or the import
/// found): Tidy switches to it when it is one of Tidy's folders, shows it in the Library when one
/// holds it, and otherwise offers to add it. In a sandboxed run a folder outside the sandbox is
/// refused with the rule.
pub fn offer(state: &Entity<TidyState>, folder: PathBuf, window: &mut Window, cx: &mut App) {
    let folder = resolved(folder);
    let current = state.read(cx);
    if let Some(root) = current
        .roots()
        .iter()
        .find(|root| relative_inside(Path::new(&root.path), &folder).as_deref() == Some(""))
    {
        let root_id = root.id;
        state.update(cx, |state, cx| state.select_root(root_id, cx));
        return;
    }
    if closest_folder(current.roots(), &folder, |root| Path::new(&root.path)).is_some() {
        take(state, HandOff::Folder(folder), window, cx);
        return;
    }
    let data = current.data().clone();
    if !data.admits_tidy_root(&folder) {
        explain_sandbox(&folder, &data, window, cx);
        return;
    }
    confirm_adding(state, folder, None, window, cx);
}

/// Asks before Tidy takes on a folder (`desktop.confirm`): a file's folder, saying why, or a
/// folder picked from another mode's.
fn confirm_adding(
    state: &Entity<TidyState>,
    folder: PathBuf,
    why: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) {
    let state = state.clone();
    let title = format!("Tidy “{}”?", file_name(&folder));
    let description = format!(
        "{}Tidy adds {} and scans it; nothing in it changes until you ask.",
        why.map(|why| format!("{why} ")).unwrap_or_default(),
        folder.display()
    );
    window.open_alert_dialog(cx, move |alert, _, _| {
        let (state, folder) = (state.clone(), folder.clone());
        alert
            .title(title.clone())
            .description(description.clone())
            .confirm()
            .ok_text("Tidy It")
            .ok_variant(ButtonVariant::Primary)
            .cancel_text("Cancel")
            .on_ok(move |_, window, cx| {
                let folder = folder.clone();
                state.update(cx, |state, cx| state.add_folder(folder, window, cx));
                true
            })
    });
}

/// A sandboxed run changes files only inside the sandbox, so a folder outside it is refused with
/// the reason, rather than offered and then refused. The owner's run never gets here.
fn explain_sandbox(folder: &Path, data: &DataRoot, window: &mut Window, cx: &mut App) {
    widgets::show_toast(
        window,
        Toast::info(format!("Tidy can't take “{}”", file_name(folder))).detail(sandbox_rule(data)),
        cx,
    );
}

/// Where Tidy may work in a sandboxed run, in one sentence, for wherever a folder is refused.
pub fn sandbox_rule(data: &DataRoot) -> String {
    format!(
        "With ORIEL_RS_DATA_DIR set, Tidy works only on folders inside {} or the temp folder.",
        data.sandbox().display()
    )
}

fn resolved(path: PathBuf) -> PathBuf {
    oriel_runtime::paths::canonicalize(&path).unwrap_or(path)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}
