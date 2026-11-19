//! The app's name in the sidebar's top strip, at the size of a page's title in the top bar beside
//! it, so the two read as one band across the window's top. It takes no clicks and no Tab stop,
//! so a press on it still moves the window and a double-click still does what the title bar does.

use gpui_kit::{
    App, FontWeight, InteractiveElement, IntoElement, ParentElement, RenderOnce, Role,
    StatefulInteractiveElement as _, Styled, TestSupportExt as _, Window, div, px,
};

use crate::controls::TextRole as _;
use crate::layout::SIDEBAR_STRIP_HEIGHT;

const NAME: &str = "Oriel";

/// On macOS the name's left edge meets the switcher's middle segment, which leaves a gap after the
/// window buttons. Elsewhere the strip has no window buttons, so the name starts on the sidebar's
/// content edge, with the folder and the section titles.
const LEFT: f32 = if cfg!(target_os = "macos") { 86. } else { 18. };

/// The height the name centres in. On macOS that puts its centre on the window buttons', 29 px
/// down; elsewhere it centres in the strip.
const ROW_HEIGHT: f32 = if cfg!(target_os = "macos") {
    58.
} else {
    SIDEBAR_STRIP_HEIGHT
};

/// The name, for one sidebar strip.
#[derive(IntoElement)]
pub struct AppMark;

impl AppMark {
    /// The name for a sidebar, or none for the rail, which has no room for it.
    pub fn for_sidebar(rail: bool) -> Option<Self> {
        (!rail).then_some(Self)
    }
}

impl RenderOnce for AppMark {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .id("app-mark")
            .test_support()
            .role(Role::Label)
            .aria_label(NAME)
            .flex()
            .items_center()
            .flex_1()
            .min_w_0()
            .h(px(ROW_HEIGHT))
            .pl(px(LEFT))
            .child(
                div()
                    .truncate()
                    .text_title()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(NAME),
            )
    }
}
