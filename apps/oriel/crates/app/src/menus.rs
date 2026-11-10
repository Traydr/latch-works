//! The menu bar, rebuilt around the mode on screen: the shell's own items, with the mode's
//! commands woven into File, Edit and View, a check mark on the mode, and the shortcut sheet in
//! Help. An item whose action nothing on screen handles is greyed out by GPUI, so a mode's items
//! light up once the mode handles their commands.

use gpui_kit::{Action, App, Menu, MenuItem, OsAction, SystemMenuType};
use oriel_ui::shortcuts::ShowShortcuts;
use oriel_ui::{Command, MenuSlot, ModeId};

use crate::actions::{
    About, BringAllToFront, CloseWindow, Hide, HideOthers, Minimize, OpenSettings, Quit,
    ShellCommand, ShowAll, ShowMode, ToggleFullScreen, ToggleRail, Zoom, shell_commands,
};

fn action_item(name: &str, action: &dyn Action) -> MenuItem {
    MenuItem::Action {
        name: name.to_owned().into(),
        action: action.boxed_clone(),
        os_action: None,
        checked: false,
        disabled: false,
    }
}

/// The shell's command `action` as an item, labelled as [`shell_commands`] has it.
fn shell_item(shell: &[ShellCommand], action: &dyn Action) -> MenuItem {
    let command = shell
        .iter()
        .find(|command| command.action.partial_eq(action))
        .expect("every shell item is one of the shell's commands");
    action_item(command.label, action)
}

/// The mode's commands in `slot`, as menu items.
fn items_in(commands: &[Command], slot: MenuSlot) -> Vec<MenuItem> {
    commands
        .iter()
        .filter_map(|command| match &command.menu {
            Some((each, label)) if *each == slot => Some(action_item(label, &*command.action)),
            _ => None,
        })
        .collect()
}

/// The text fields' Edit menu, with the mode's commands standing in for Undo and Select All
/// where it has them, and its own at the end.
fn edit_menu(commands: &[Command]) -> Vec<MenuItem> {
    let stand_in = |slot, standard: MenuItem| items_in(commands, slot).pop().unwrap_or(standard);
    let mut items = vec![
        stand_in(
            MenuSlot::Undo,
            MenuItem::os_action("Undo", gpui_kit::component::input::Undo, OsAction::Undo),
        ),
        MenuItem::os_action("Redo", gpui_kit::component::input::Redo, OsAction::Redo),
        MenuItem::separator(),
        MenuItem::os_action("Cut", gpui_kit::component::input::Cut, OsAction::Cut),
        MenuItem::os_action("Copy", gpui_kit::component::input::Copy, OsAction::Copy),
        MenuItem::os_action("Paste", gpui_kit::component::input::Paste, OsAction::Paste),
        stand_in(
            MenuSlot::SelectAll,
            MenuItem::os_action(
                "Select All",
                gpui_kit::component::input::SelectAll,
                OsAction::SelectAll,
            ),
        ),
    ];
    let own = items_in(commands, MenuSlot::Edit);
    if !own.is_empty() {
        items.push(MenuItem::separator());
        items.extend(own);
    }
    items
}

/// The menu bar while `mode`, with `commands`, is on screen.
pub fn menus(mode: ModeId, commands: &[Command]) -> Vec<Menu> {
    menus_for(mode, commands, cfg!(target_os = "macos"))
}

/// The menu bar on macOS (`mac`), or in the window elsewhere: off macOS there is no app menu, so
/// File ends with Settings and Exit, the Window menu has Minimize and Close, and Help carries
/// About.
fn menus_for(mode: ModeId, commands: &[Command], mac: bool) -> Vec<Menu> {
    let shell = shell_commands(mac);
    let item = |action: &dyn Action| shell_item(&shell, action);
    let mut file_items = items_in(commands, MenuSlot::File);
    if !file_items.is_empty() {
        file_items.push(MenuItem::separator());
    }
    if mac {
        file_items.push(item(&CloseWindow));
    } else {
        file_items.extend([item(&OpenSettings), MenuItem::separator(), item(&Quit)]);
    }

    let mut view_items: Vec<MenuItem> = ModeId::ALL
        .into_iter()
        .map(|each| MenuItem::action(each.label(), ShowMode(each)).checked(each == mode))
        .collect();
    let view = items_in(commands, MenuSlot::View);
    if !view.is_empty() {
        view_items.push(MenuItem::separator());
        view_items.extend(view);
    }
    view_items.extend([
        MenuItem::separator(),
        item(&ToggleRail),
        item(&ToggleFullScreen),
    ]);

    let app_menu = Menu {
        name: oriel_core_paths::APP_NAME.into(),
        items: vec![
            item(&About),
            MenuItem::separator(),
            item(&OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            item(&Hide),
            item(&HideOthers),
            item(&ShowAll),
            MenuItem::separator(),
            item(&Quit),
        ],
        disabled: false,
    };
    let window_items = if mac {
        vec![
            item(&Minimize),
            item(&Zoom),
            MenuItem::separator(),
            item(&BringAllToFront),
        ]
    } else {
        vec![item(&Minimize), item(&CloseWindow)]
    };
    let mut bar = mac.then_some(app_menu).into_iter().collect::<Vec<_>>();
    bar.extend([
        Menu {
            name: "File".into(),
            items: file_items,
            disabled: false,
        },
        Menu {
            name: "Edit".into(),
            items: edit_menu(commands),
            disabled: false,
        },
        Menu {
            name: "View".into(),
            items: view_items,
            disabled: false,
        },
        Menu {
            name: "Window".into(),
            items: window_items,
            disabled: false,
        },
    ]);
    let mut help = vec![MenuItem::action("Keyboard Shortcuts", ShowShortcuts)];
    if !mac {
        help.push(MenuItem::separator());
        help.push(item(&About));
    }
    bar.push(Menu {
        name: "Help".into(),
        items: help,
        disabled: false,
    });
    bar
}

/// Sets the menu bar for `mode`, with `commands`. The keys must be bound first: the menu reads
/// its shortcuts from the keymap as it is built.
pub fn set(mode: ModeId, commands: &[Command], cx: &mut App) {
    cx.set_menus(menus(mode, commands));
    #[cfg(windows)]
    crate::windows_frame::reload_menus(cx);
}

/// AppKit adds an Enter Full Screen item of its own to a menu named View, which would sit beside
/// Toggle Full Screen. Call once, before the first menu bar.
pub fn prepare() {
    #[cfg(target_os = "macos")]
    objc2_foundation::NSUserDefaults::standardUserDefaults().setBool_forKey(
        false,
        objc2_foundation::ns_string!("NSFullScreenMenuItemEverywhere"),
    );
}
