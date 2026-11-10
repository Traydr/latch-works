//! Oriel's house kit on GPUI Kit: the theme, the icons, and the parts every mode's window is
//! made of (the sidebar with the mode switcher and Settings, the top bar, the strips that move the
//! window), with what the shell and the modes agree on: the interface every mode offers the shell
//! ([`Mode`]), toasts, the store of preferences, Settings' groups and rows, the folders the modes
//! offer each other, the jobs they run, which the shell shows in one place, and what the
//! measurements read.

pub mod activity;
pub mod app_mark;
pub mod arming;
pub mod assets;
pub mod controls;
pub mod cursor;
pub mod dialogs;
pub mod drag;
pub mod focus;
pub mod folders;
pub mod image_cache;
pub mod job;
pub mod keys;
pub mod layout;
pub mod locations;
pub mod measure;
pub mod mode;
pub mod popups;
pub mod redraw;
pub mod segmented;
pub mod settings;
pub mod shell;
pub mod shortcuts;
pub mod storage;
#[cfg(feature = "test-support")]
pub mod test_window;
pub mod theme;
pub mod toast;
pub mod top_bar;

pub use activity::{Activity, ActivityIndicator, ActivityJob, JobCommand, JobControl, JobState};
pub use arming::{ARM_DELAY, Arming};
pub use assets::OrielAssets;
pub use controls::{
    ControlSize, MENU_ROW_HEIGHT, MIN_TARGET, STAGE_RING, TextRole, checkbox_target, menu_row,
    on_dark_stage, switch,
};
pub use folders::{HandOff, KnownFolder, OfferedFolders};
pub use job::{AnyJob, Job, JobError, JobEvent, JobProgress, JobReporter, JobStatus};
pub use layout::{KeepsFocus, ModeLayout, stand_on_foot};
pub use locations::{LocationItem, LocationSwitcher};
pub use mode::{
    AnyMode, Command, FolderSetUp, Foot, MenuSlot, Mode, ModeMap, PaneServer, mode_key_context,
    shell_key_context,
};
pub use settings::{SettingsGroup, SettingsRow};
pub use shell::{
    HandOffRequest, ModeActivity, ModeId, ModeReporter, SettingsSection, ShellState, Work,
};
pub use storage::LocalStorage;
pub use toast::{Toast, ToastExt};
pub use top_bar::TopBar;
