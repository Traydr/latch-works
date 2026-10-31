//! The modes' menu commands: what Electron Oriel's modes add to the app menu while they are on
//! screen (`viewMenu`, `tidyMenu`). The shell puts them in the menu bar and binds their keys; a
//! mode handles one by putting `.on_action(cx.listener(…))` on its root element.
//!
//! A menu item is enabled only while its action has a handler on the focused element's path, so
//! an item stays greyed out until its mode handles it, and keys reach only the mode on screen.
//!
//! The keys are bound under the shell's key context, which names the mode on screen, so ⌘O is
//! Open Folder… in View and Add Folder… in Tidy, as in Electron Oriel.

use gpui_kit::{App, KeyBinding, KeyContext, actions};

use crate::shell::ModeId;

actions!(
    oriel_mode,
    [
        /// View: File › Open Folder… (⌘O), the system's folder picker.
        OpenFolder,
        /// View: File › Refresh (⌘R), the folder on screen read again.
        Refresh,
        /// Tidy: File › Add Folder… (⌘O).
        AddFolder,
        /// Tidy: File › Rescan (⌘R).
        Rescan,
        /// Tidy: Edit › Undo (⌘Z): the last change, or the text field's own undo when one has
        /// focus.
        UndoChange,
        /// Tidy: Edit › Select All (⌘A): every file on the page, or the text field's text.
        SelectAllItems,
        /// Tidy: Edit › Find (⌘F), the page's search.
        Find,
        /// Tidy: Help › Keyboard Shortcuts, the shortcut sheet.
        ShowShortcuts,
        /// Tidy: View › Overview (⌥⌘1).
        ShowOverview,
        /// Tidy: View › Duplicates (⌥⌘2).
        ShowDuplicates,
        /// Tidy: View › Convert (⌥⌘3).
        ShowConvert,
        /// Tidy: View › Clean Up (⌥⌘4).
        ShowCleanUp,
        /// Tidy: View › Library (⌥⌘5).
        ShowLibrary,
        /// Tidy: View › History (⌥⌘6).
        ShowHistory,
        /// Tidy: View › Holding (⌥⌘7).
        ShowHolding,
    ]
);

/// The key context the shell's root element sets: `Shell`, with the mode on screen as
/// `mode = view`, `tidy` or `sync`.
pub fn shell_key_context(mode: ModeId) -> KeyContext {
    let mut context = KeyContext::default();
    context.add("Shell");
    context.set("mode", mode.key());
    context
}

fn in_mode(mode: ModeId) -> String {
    format!("Shell && mode == {}", mode.key())
}

/// Binds the modes' keys. Call before the menus are set, which read the keymap for their
/// shortcuts.
pub fn bind_keys(cx: &mut App) {
    let view = in_mode(ModeId::View);
    let tidy = in_mode(ModeId::Tidy);
    cx.bind_keys([
        KeyBinding::new("cmd-o", OpenFolder, Some(&view)),
        KeyBinding::new("cmd-r", Refresh, Some(&view)),
        KeyBinding::new("cmd-o", AddFolder, Some(&tidy)),
        KeyBinding::new("cmd-r", Rescan, Some(&tidy)),
        KeyBinding::new("cmd-z", UndoChange, Some(&tidy)),
        KeyBinding::new("cmd-a", SelectAllItems, Some(&tidy)),
        KeyBinding::new("cmd-f", Find, Some(&tidy)),
        KeyBinding::new("alt-cmd-1", ShowOverview, Some(&tidy)),
        KeyBinding::new("alt-cmd-2", ShowDuplicates, Some(&tidy)),
        KeyBinding::new("alt-cmd-3", ShowConvert, Some(&tidy)),
        KeyBinding::new("alt-cmd-4", ShowCleanUp, Some(&tidy)),
        KeyBinding::new("alt-cmd-5", ShowLibrary, Some(&tidy)),
        KeyBinding::new("alt-cmd-6", ShowHistory, Some(&tidy)),
        KeyBinding::new("alt-cmd-7", ShowHolding, Some(&tidy)),
    ]);
}
