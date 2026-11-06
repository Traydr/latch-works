//! Oriel's house kit on GPUI Kit: the theme, the icons, and the parts every mode's window is
//! made of (the sidebar with the mode switcher and Settings, the top bar, the strips that move the
//! window), with what the shell offers the modes: the mode commands of the menu bar, toasts, the
//! store of preferences, Settings' groups and rows, the folders the modes offer each other, and
//! the jobs they run, which the shell shows in one place.

pub mod activity;
pub mod app_mark;
pub mod assets;
pub mod commands;
pub mod controls;
pub mod dialogs;
pub mod drag;
pub mod focus;
pub mod folders;
pub mod keys;
pub mod layout;
pub mod locations;
pub mod popups;
pub mod redraw;
pub mod segmented;
pub mod settings;
pub mod shell;
pub mod shortcuts;
pub mod storage;
pub mod theme;
pub mod toast;
pub mod top_bar;

pub use activity::{Activity, ActivityIndicator, ActivityJob, JobCommand, JobControl, JobState};
pub use assets::OrielAssets;
pub use controls::{
    ControlSize, MENU_ROW_HEIGHT, MIN_TARGET, STAGE_RING, TextRole, checkbox_target, menu_row,
    on_dark_stage, switch,
};
pub use folders::{HandOff, KnownFolder, OfferedFolders};
pub use layout::{KeepsFocus, ModeLayout};
pub use locations::{LocationItem, LocationSwitcher};
pub use settings::{SettingsGroup, SettingsRow};
pub use shell::{ModeActivity, ModeId, SettingsSection, ShellState};
pub use storage::LocalStorage;
pub use toast::{Toast, ToastExt};
pub use top_bar::TopBar;
