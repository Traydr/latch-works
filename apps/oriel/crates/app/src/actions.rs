//! The app's actions and their keys, and the modes' command keys. Keys reach an action through
//! the focused element's key context, so a hidden mode, which is not drawn, cannot receive them.

use std::rc::Rc;

use gpui_kit::{Action, App, Global, KeyBinding, KeyBindingContextPredicate, actions};
use oriel_ui::shortcuts::Line;
use oriel_ui::{AnyMode, ModeId, ModeMap, cmd_or_ctrl, mode_key_context};

use crate::quit::QuitGuard;

/// Shows a mode (⌘1–3).
#[derive(Clone, Copy, Debug, PartialEq, Action)]
#[action(namespace = oriel, no_json)]
pub struct ShowMode(pub ModeId);

actions!(
    oriel,
    [
        /// The sidebar full or as the rail (⌘\).
        ToggleRail,
        /// The one Settings page, at the section of the mode on screen (⌘,).
        OpenSettings,
        /// Back from Settings to the mode (Escape).
        CloseSettings,
        /// The window full screen and back (⌃⌘F).
        ToggleFullScreen,
        About,
        Hide,
        HideOthers,
        ShowAll,
        Minimize,
        Zoom,
        /// Window › Bring All to Front.
        BringAllToFront,
        /// Closes the window, which quits, unless work runs that quitting waits for (⌘W).
        CloseWindow,
        /// Quits, unless work runs that quitting waits for (⌘Q).
        Quit
    ]
);

/// The key context of the Settings page, where Escape goes back.
pub const SETTINGS_CONTEXT: &str = "Settings";

/// One of the shell's own commands: its action, its label in the menu bar and the shortcut sheet,
/// and its keys, bound everywhere unless `context` names where.
pub struct ShellCommand {
    pub action: Box<dyn Action>,
    pub label: &'static str,
    pub keys: Option<&'static str>,
    context: Option<&'static str>,
}

impl ShellCommand {
    fn new(action: impl Action, label: &'static str, keys: Option<&'static str>) -> Self {
        Self {
            action: Box::new(action),
            label,
            keys,
            context: None,
        }
    }

    /// Its line in the shortcut sheet, when it has keys bound everywhere.
    pub fn sheet_line(&self) -> Option<Line> {
        if self.context.is_some() {
            return None;
        }
        Some(Line::new(self.label.trim_end_matches('…'), self.keys?))
    }
}

/// The shell's commands on macOS (`mac`) or elsewhere, which the keys, the menu bar and the
/// shortcut sheet all read.
pub fn shell_commands(mac: bool) -> Vec<ShellCommand> {
    let on_mac = |keys| mac.then_some(keys);
    vec![
        ShellCommand::new(OpenSettings, "Settings…", Some(oriel_ui::keys::SETTINGS)),
        ShellCommand::new(ToggleRail, "Toggle Sidebar", Some(oriel_ui::keys::SIDEBAR)),
        ShellCommand::new(
            ToggleFullScreen,
            "Toggle Full Screen",
            Some(if mac { "ctrl-cmd-f" } else { "f11" }),
        ),
        ShellCommand::new(Minimize, "Minimize", Some(cmd_or_ctrl!("m"))),
        ShellCommand::new(
            CloseWindow,
            if mac { "Close Window" } else { "Close" },
            Some(cmd_or_ctrl!("w")),
        ),
        ShellCommand::new(
            Quit,
            if mac { "Quit Oriel" } else { "Exit" },
            Some(cmd_or_ctrl!("q")),
        ),
        ShellCommand::new(Hide, "Hide Oriel", on_mac("cmd-h")),
        ShellCommand::new(HideOthers, "Hide Others", on_mac("alt-cmd-h")),
        ShellCommand::new(ShowAll, "Show All", None),
        ShellCommand::new(Zoom, "Zoom", None),
        ShellCommand::new(BringAllToFront, "Bring All to Front", None),
        ShellCommand::new(About, "About Oriel", None),
        ShellCommand {
            context: Some(SETTINGS_CONTEXT),
            ..ShellCommand::new(CloseSettings, "Back", Some("escape"))
        },
    ]
}

/// Binds the shell's keys and the app-wide actions. Call before the menus are set: they read
/// their shortcuts from the keymap.
pub fn init(cx: &mut App) {
    cx.bind_keys(ModeId::ALL.map(|mode| KeyBinding::new(mode.keys(), ShowMode(mode), None)));
    let mut bindings = Vec::new();
    for command in shell_commands(cfg!(target_os = "macos")) {
        let Some(keys) = command.keys else {
            continue;
        };
        let context = command.context.map(|context| {
            KeyBindingContextPredicate::parse(context)
                .map(Rc::new)
                .expect("the shell's key contexts parse")
        });
        match KeyBinding::load(keys, command.action, context, false, None, cx) {
            Ok(binding) => bindings.push(binding),
            Err(error) => log::error!("the shell cannot bind {keys}: {error}"),
        }
    }
    cx.bind_keys(bindings);

    cx.on_action(|_: &Quit, cx| QuitGuard::request_global(cx));
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| bring_all_to_front(cx));
    // One window: closing it quits. The window asks first whether work is running that the quit
    // must wait for (`Shell::allows_close`).
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
}

/// Marks the modes' command keys as bound, so a second window does not bind them twice.
struct ModeKeys;

impl Global for ModeKeys {}

/// Binds each mode's command keys, in force while that mode is on screen.
pub fn bind_mode_keys(modes: &ModeMap<AnyMode>, cx: &mut App) {
    if cx.has_global::<ModeKeys>() {
        return;
    }
    cx.set_global(ModeKeys);
    let mut bindings = Vec::new();
    for (mode, entry) in modes.iter() {
        let context = KeyBindingContextPredicate::parse(&mode_key_context(mode))
            .map(Rc::new)
            .expect("a mode's key context parses");
        for command in entry.commands() {
            let Some(keys) = command.keys else {
                continue;
            };
            match KeyBinding::load(keys, command.action, Some(context.clone()), false, None, cx) {
                Ok(binding) => bindings.push(binding),
                Err(error) => log::error!("{} cannot bind {keys}: {error}", mode.label()),
            }
        }
    }
    cx.bind_keys(bindings);
}

/// Brings the app forward with its windows in front of every other app's, as AppKit's Window ›
/// Bring All to Front does (`arrangeInFront:`).
fn bring_all_to_front(cx: &mut App) {
    cx.activate(true);
    #[cfg(target_os = "macos")]
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        objc2_app_kit::NSApplication::sharedApplication(mtm).arrangeInFront(None);
    }
}
