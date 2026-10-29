//! Oriel RS's house kit on GPUI Kit: the theme, the icons, and the parts every mode's window is
//! made of (the sidebar with the mode switcher and Settings, the top bar, the strips that move the
//! window), with what the shell offers the modes: the mode commands of the menu bar, toasts, the
//! store of preferences, Settings' groups and rows, and the folders the modes offer each other.

pub mod assets;
pub mod commands;
pub mod drag;
pub mod folders;
pub mod layout;
pub mod segmented;
pub mod settings;
pub mod shell;
pub mod storage;
pub mod theme;
pub mod toast;
pub mod top_bar;

pub use assets::OrielAssets;
pub use folders::{HandOff, KnownFolder, OfferedFolders};
pub use layout::{KeepsFocus, ModeLayout};
pub use settings::{SettingsGroup, SettingsRow};
pub use shell::{ModeActivity, ModeId, SettingsSection, ShellState};
pub use storage::LocalStorage;
pub use toast::{Toast, ToastExt};
pub use top_bar::TopBar;
