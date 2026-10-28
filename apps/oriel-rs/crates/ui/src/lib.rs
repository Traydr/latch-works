//! Oriel RS's house kit on GPUI Kit: the theme, the icons, and the parts every mode's window is
//! made of (the sidebar with the mode switcher, the top bar, the strips that move the window).

pub mod assets;
pub mod drag;
pub mod layout;
pub mod shell;
pub mod theme;
pub mod top_bar;

pub use assets::OrielAssets;
pub use layout::ModeLayout;
pub use shell::{ModeActivity, ModeId, ShellState};
pub use top_bar::TopBar;
