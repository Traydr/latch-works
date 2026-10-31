//! The menu bar, rebuilt around the mode on screen as Electron Oriel's `appMenu` is: the shell's
//! own items, with the mode's File, Edit, View and Help items woven in, and a check mark on the
//! mode. An item whose action nothing on screen handles is greyed out by GPUI, so a mode's items
//! light up once the mode handles their commands.

use gpui_kit::{App, Menu, MenuItem, OsAction, SystemMenuType};
use oriel_ui::ModeId;
use oriel_ui::commands::{
    AddFolder, Find, OpenFolder, Refresh, Rescan, SelectAllItems, ShowCleanUp, ShowConvert,
    ShowDuplicates, ShowHistory, ShowHolding, ShowLibrary, ShowOverview, ShowShortcuts, UndoChange,
};

use crate::actions::{
    About, BringAllToFront, CloseWindow, Hide, HideOthers, Minimize, OpenSettings, Quit, ShowAll,
    ShowSync, ShowTidy, ShowView, ToggleFullScreen, ToggleRail, Zoom,
};

/// The name of the View menu item that shows `mode`.
fn mode_item(mode: ModeId, current: ModeId) -> MenuItem {
    let item = match mode {
        ModeId::View => MenuItem::action(mode.label(), ShowView),
        ModeId::Tidy => MenuItem::action(mode.label(), ShowTidy),
        ModeId::Sync => MenuItem::action(mode.label(), ShowSync),
    };
    item.checked(mode == current)
}

/// What a mode adds to the menu while it is on screen (`ModeMenu`).
struct ModeMenu {
    /// Items at the top of File.
    file: Vec<MenuItem>,
    /// The whole Edit menu, for a mode that routes Undo and Select All itself.
    edit: Option<Vec<MenuItem>>,
    /// Items after the modes in View.
    view: Vec<MenuItem>,
    help: Vec<MenuItem>,
}

fn mode_menu(mode: ModeId) -> ModeMenu {
    match mode {
        ModeId::View => ModeMenu {
            file: vec![
                MenuItem::action("Open Folder…", OpenFolder),
                MenuItem::action("Refresh", Refresh),
            ],
            edit: None,
            view: Vec::new(),
            help: Vec::new(),
        },
        ModeId::Tidy => ModeMenu {
            file: vec![
                MenuItem::action("Add Folder…", AddFolder),
                MenuItem::action("Rescan", Rescan),
            ],
            edit: Some(vec![
                MenuItem::action("Undo", UndoChange),
                MenuItem::os_action("Redo", gpui_kit::component::input::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Cut", gpui_kit::component::input::Cut, OsAction::Cut),
                MenuItem::os_action("Copy", gpui_kit::component::input::Copy, OsAction::Copy),
                MenuItem::os_action("Paste", gpui_kit::component::input::Paste, OsAction::Paste),
                MenuItem::action("Select All", SelectAllItems),
                MenuItem::separator(),
                MenuItem::action("Find", Find),
            ]),
            // ⌘1–3 switch the modes, so Tidy's pages take ⌥⌘1–7.
            view: vec![
                MenuItem::action("Overview", ShowOverview),
                MenuItem::action("Duplicates", ShowDuplicates),
                MenuItem::action("Convert", ShowConvert),
                MenuItem::action("Clean Up", ShowCleanUp),
                MenuItem::action("Library", ShowLibrary),
                MenuItem::action("History", ShowHistory),
                MenuItem::action("Holding", ShowHolding),
            ],
            help: vec![MenuItem::action("Keyboard Shortcuts", ShowShortcuts)],
        },
        // Sync adds nothing to the menu, as in Electron Oriel.
        ModeId::Sync => ModeMenu {
            file: Vec::new(),
            edit: None,
            view: Vec::new(),
            help: Vec::new(),
        },
    }
}

/// The Edit menu every mode but Tidy has: the text fields' commands.
fn standard_edit() -> Vec<MenuItem> {
    vec![
        MenuItem::os_action("Undo", gpui_kit::component::input::Undo, OsAction::Undo),
        MenuItem::os_action("Redo", gpui_kit::component::input::Redo, OsAction::Redo),
        MenuItem::separator(),
        MenuItem::os_action("Cut", gpui_kit::component::input::Cut, OsAction::Cut),
        MenuItem::os_action("Copy", gpui_kit::component::input::Copy, OsAction::Copy),
        MenuItem::os_action("Paste", gpui_kit::component::input::Paste, OsAction::Paste),
        MenuItem::os_action(
            "Select All",
            gpui_kit::component::input::SelectAll,
            OsAction::SelectAll,
        ),
    ]
}

/// The menu bar while `mode` is on screen.
pub fn menus(mode: ModeId) -> Vec<Menu> {
    menus_for(mode, cfg!(target_os = "macos"))
}

/// The menu bar on macOS (`mac`), or in the window elsewhere, as Electron Oriel's template
/// differs: off macOS there is no app menu, so File ends with Settings and Exit, the Window menu
/// has Minimize and Close, and Help carries About.
fn menus_for(mode: ModeId, mac: bool) -> Vec<Menu> {
    let ModeMenu {
        file,
        edit,
        view,
        help,
    } = mode_menu(mode);

    let mut file_items = file;
    if !file_items.is_empty() {
        file_items.push(MenuItem::separator());
    }
    if mac {
        file_items.push(MenuItem::action("Close Window", CloseWindow));
    } else {
        file_items.extend([
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::action("Exit", Quit),
        ]);
    }

    let mut view_items: Vec<MenuItem> = ModeId::ALL
        .into_iter()
        .map(|each| mode_item(each, mode))
        .collect();
    if !view.is_empty() {
        view_items.push(MenuItem::separator());
        view_items.extend(view);
    }
    view_items.extend([
        MenuItem::separator(),
        MenuItem::action("Toggle Sidebar", ToggleRail),
        MenuItem::action("Toggle Full Screen", ToggleFullScreen),
    ]);

    let app_menu = Menu {
        name: crate::APP_NAME.into(),
        items: vec![
            MenuItem::action("About Oriel", About),
            MenuItem::separator(),
            // One Settings page for every mode, opened at the section of the mode on screen.
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Oriel", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit Oriel", Quit),
        ],
        disabled: false,
    };
    let window_items = if mac {
        // Electron's `windowMenu` role on macOS.
        vec![
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Bring All to Front", BringAllToFront),
        ]
    } else {
        // And elsewhere.
        vec![
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Close", CloseWindow),
        ]
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
            items: edit.unwrap_or_else(standard_edit),
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
    let mut help = help;
    if !mac {
        if !help.is_empty() {
            help.push(MenuItem::separator());
        }
        help.push(MenuItem::action("About Oriel", About));
    }
    if !help.is_empty() {
        bar.push(Menu {
            name: "Help".into(),
            items: help,
            disabled: false,
        });
    }
    bar
}

/// Sets the menu bar for `mode`. The keys must be bound first: the menu reads its shortcuts from
/// the keymap as it is built.
pub fn set(mode: ModeId, cx: &mut App) {
    cx.set_menus(menus(mode));
    #[cfg(windows)]
    crate::windows_frame::reload_menus(cx);
}

/// AppKit adds an Enter Full Screen item of its own to a menu named View, which would sit beside
/// Toggle Full Screen; Electron turns it off the same way. Call once, before the first menu bar.
pub fn prepare() {
    #[cfg(target_os = "macos")]
    objc2_foundation::NSUserDefaults::standardUserDefaults().setBool_forKey(
        false,
        objc2_foundation::ns_string!("NSFullScreenMenuItemEverywhere"),
    );
}
