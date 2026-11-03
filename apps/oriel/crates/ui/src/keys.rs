//! The command key: ⌘ on macOS and Ctrl elsewhere, as Electron's `CmdOrCtrl` reads.
//!
//! GPUI reads `cmd-` as the Windows key on Windows, where Windows keeps most of its combinations
//! for itself (⊞1 opens the first taskbar app, ⊞M minimises every window). GPUI's own
//! `secondary-` means ⌘ or Ctrl, but `KeyBinding::new` parses without knowing the system and
//! refuses it, so the bindings name the key through [`cmd_or_ctrl!`] instead.

use gpui_kit::Modifiers;

/// `cmd-<keys>` on macOS and `ctrl-<keys>` elsewhere, as a `&'static str` for
/// `KeyBinding::new`: `cmd_or_ctrl!("alt-1")` is ⌥⌘1 on macOS and Ctrl+Alt+1 on Windows.
#[macro_export]
macro_rules! cmd_or_ctrl {
    ($keys:literal) => {
        if cfg!(target_os = "macos") {
            concat!("cmd-", $keys)
        } else {
            concat!("ctrl-", $keys)
        }
    };
}

/// Whether the command key is held, for a key or click handler: ⌘ on macOS, where Ctrl does not
/// stand in for it, and Ctrl elsewhere.
pub fn command_held(modifiers: &Modifiers) -> bool {
    if cfg!(target_os = "macos") {
        modifiers.platform
    } else {
        modifiers.control
    }
}
