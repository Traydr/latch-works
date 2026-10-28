//! The native menu bar.

use gpui_kit::{App, Menu, MenuItem, OsAction, SystemMenuType};

use crate::actions::{
    About, CloseWindow, Hide, HideOthers, Minimize, Quit, ShowAll, ShowSync, ShowTidy, ShowView,
    ToggleRail, Zoom,
};

pub fn init(cx: &mut App) {
    cx.set_menus([
        Menu {
            name: crate::APP_NAME.into(),
            items: vec![
                MenuItem::action("About Oriel RS", About),
                MenuItem::separator(),
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("Hide Oriel RS", Hide),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action("Quit Oriel RS", Quit),
            ],
            disabled: false,
        },
        Menu {
            name: "File".into(),
            items: vec![MenuItem::action("Close Window", CloseWindow)],
            disabled: false,
        },
        Menu {
            name: "Edit".into(),
            items: vec![
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
            ],
            disabled: false,
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("View", ShowView),
                MenuItem::action("Tidy", ShowTidy),
                MenuItem::action("Sync", ShowSync),
                MenuItem::separator(),
                MenuItem::action("Toggle Sidebar", ToggleRail),
            ],
            disabled: false,
        },
        Menu {
            name: "Window".into(),
            items: vec![
                MenuItem::action("Minimize", Minimize),
                MenuItem::action("Zoom", Zoom),
            ],
            disabled: false,
        },
    ]);
}
