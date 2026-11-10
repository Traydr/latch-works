//! What Tidy hands the other modes, and what it takes from them: Open in View, Sync this folder,
//! and a hand-off from another mode.
//!
//! The pages ask [`TidyState`] to open a file or folder in View, or to sync a folder; it asks the
//! shell to hand it over. A file or folder another mode hands Tidy is shown by [`take`]: at the
//! Library, filtered to it, in the folder of Tidy's that holds it. A folder no folder of Tidy's
//! holds is added, once the owner agrees for a file's folder. A folder picked in the location
//! switcher's menu is [`offer`]ed. In a sandboxed run (`ORIEL_DATA_DIR` set) only folders inside
//! the sandbox can be, so for any other Tidy says why instead.

use std::path::{Path, PathBuf};

use gpui_kit::component::WindowExt as _;
use gpui_kit::{App, Entity, Window};
use oriel_core_paths::DataRoot;
use oriel_core_tidy::contract::Root;
pub use oriel_core_tidy::sandbox_rule;
use oriel_core_tidy::{relative_within, roots_overlap};
use oriel_ui::ToastExt as _;
use oriel_ui::{HandOff, Toast};

use crate::labels::file_name;
use crate::state::{LibraryPreset, TidyState};

/// Shows `target`, which another mode handed Tidy. Call it once Tidy's engine
/// has listed its folders.
pub fn take(state: &Entity<TidyState>, target: HandOff, window: &mut Window, cx: &mut App) {
    // Tidy's folders are kept resolved, so the path handed over is resolved too.
    let target = match target {
        HandOff::File(path) => HandOff::File(resolved(path)),
        HandOff::Folder(path) => HandOff::Folder(resolved(path)),
    };
    let current = state.read(cx);
    let folder = target.folder().to_path_buf();
    if let Some(root) = holder(current.roots(), &folder).cloned() {
        let dir = relative_within(&folder, Path::new(&root.path)).filter(|dir| !dir.is_empty());
        let search = match &target {
            HandOff::File(path) => file_name(&path.to_string_lossy()).to_owned(),
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
    // larger one would overlap, and none that would overlap a folder of Tidy's.
    let overlapped = |candidate: &Path| {
        current
            .roots()
            .iter()
            .find(|root| roots_overlap(candidate, Path::new(&root.path)))
            .map(|root| root.name.clone())
    };
    let outer = current
        .shell()
        .read(cx)
        .known_folders()
        .iter()
        .map(|known| known.path())
        .filter(|known| {
            relative_within(&folder, known).is_some()
                && overlapped(known).is_none()
                && data.admits_tidy_root(known)
        })
        .min_by_key(|known| known.as_os_str().len())
        .map(Path::to_path_buf);
    let candidate = outer.unwrap_or(folder);
    if let Some(name) = overlapped(&candidate) {
        window.show_toast(
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

/// A folder picked in the location switcher's menu, which another mode uses: Tidy switches to it
/// when it is one of Tidy's folders, shows it in the Library when one holds it, and otherwise
/// offers to add it. In a sandboxed run a folder outside the sandbox is refused with the rule.
pub fn offer(state: &Entity<TidyState>, folder: PathBuf, window: &mut Window, cx: &mut App) {
    let folder = resolved(folder);
    let current = state.read(cx);
    if let Some(root) = current
        .roots()
        .iter()
        .find(|root| relative_within(&folder, Path::new(&root.path)).as_deref() == Some(""))
    {
        let root_id = root.id;
        state.update(cx, |state, cx| state.select_root(root_id, cx));
        return;
    }
    if holder(current.roots(), &folder).is_some() {
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

/// Asks before Tidy takes on a folder: a file's folder, saying why, or a
/// folder picked from another mode's.
fn confirm_adding(
    state: &Entity<TidyState>,
    folder: PathBuf,
    why: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) {
    let state = state.clone();
    let title = format!("Tidy “{}”?", file_name(&folder.to_string_lossy()));
    let description = format!(
        "{}Tidy adds {} and scans it; nothing in it changes until you ask.",
        why.map(|why| format!("{why} ")).unwrap_or_default(),
        folder.display()
    );
    window.open_alert_dialog(cx, move |alert, _, cx| {
        let (state, folder) = (state.clone(), folder.clone());
        oriel_ui::dialogs::confirmation(
            alert,
            title.clone(),
            description.clone(),
            "Tidy it",
            false,
            cx,
        )
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
    window.show_toast(
        Toast::info(format!(
            "Tidy can't take “{}”",
            file_name(&folder.to_string_lossy())
        ))
        .detail(sandbox_rule(data)),
        cx,
    );
}

fn resolved(path: PathBuf) -> PathBuf {
    oriel_runtime::paths::canonicalize(&path).unwrap_or(path)
}

/// The root that holds `folder`; roots never overlap, so at most one does.
fn holder<'a>(roots: &'a [Root], folder: &Path) -> Option<&'a Root> {
    roots
        .iter()
        .find(|root| relative_within(folder, Path::new(&root.path)).is_some())
}
