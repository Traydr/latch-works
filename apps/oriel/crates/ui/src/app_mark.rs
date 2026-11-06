//! The app's own mark in the sidebar's top strip: the icon and the name. It takes no clicks and no
//! Tab stop, so a press on it still moves the window and a double-click still does what the title
//! bar does.

use std::future::Future;
use std::sync::Arc;

use gpui_kit::{
    App, Asset, FontWeight, ImageCacheError, InteractiveElement, IntoElement, ObjectFit,
    ParentElement, RenderImage, RenderOnce, Role, SMOOTH_SVG_SCALE_FACTOR,
    StatefulInteractiveElement as _, Styled, StyledImage as _, TestSupportExt as _, Window, div,
    img, prelude::FluentBuilder as _, px,
};

use crate::controls::TextRole as _;
use crate::layout::SIDEBAR_STRIP_HEIGHT;

const NAME: &str = "Oriel";

const ICON_ARTWORK: &[u8] = include_bytes!("../../../assets/oriel-icon.svg");
/// The width and height `oriel-icon.svg` declares.
const ICON_ARTWORK_SIZE: f32 = 1024.;
const ICON_SIZE: f32 = 22.;

/// On macOS the mark's left edge meets the switcher's middle segment, which leaves a gap after the
/// window buttons. Elsewhere those buttons are in the title bar above the shell, so the strip is
/// free and the mark starts on the sidebar's content edge, with the folder and the section titles.
const LEFT: f32 = if cfg!(target_os = "macos") { 86. } else { 18. };

/// The height the mark centres in. On macOS that puts its centre on the window buttons', 29 px
/// down; elsewhere there are no buttons to meet, so it centres in the strip.
const ROW_HEIGHT: f32 = if cfg!(target_os = "macos") {
    58.
} else {
    SIDEBAR_STRIP_HEIGHT
};

/// The icon drawn for one size in device pixels. A 1024 px picture scaled down to this size by the
/// GPU comes out jagged, so the artwork is drawn afresh for the window's scale.
enum IconRaster {}

impl Asset for IconRaster {
    type Source = u32;
    type Output = Result<Arc<RenderImage>, ImageCacheError>;

    fn load(pixels: u32, cx: &mut App) -> impl Future<Output = Self::Output> + Send + 'static {
        let renderer = cx.svg_renderer();
        async move {
            // The renderer draws an SVG at this factor times the scale it is given.
            let scale = pixels as f32 / ICON_ARTWORK_SIZE / SMOOTH_SVG_SCALE_FACTOR;
            renderer
                .render_single_frame(ICON_ARTWORK, scale)
                .map_err(|error| ImageCacheError::Usvg(Arc::new(error)))
        }
    }
}

/// The mark, for one sidebar strip.
#[derive(IntoElement)]
pub struct AppMark {
    rail: bool,
}

impl AppMark {
    /// The mark for a sidebar or a rail. The window buttons fill the rail's strip on macOS, and a
    /// mark under them crowds them and the switcher, so there the rail shows none.
    pub fn for_sidebar(rail: bool) -> Option<Self> {
        (!rail || !cfg!(target_os = "macos")).then_some(Self { rail })
    }
}

impl RenderOnce for AppMark {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let icon = img(|window: &mut Window, cx: &mut App| {
            let pixels = (ICON_SIZE * window.scale_factor()).round() as u32;
            window.use_asset::<IconRaster>(&pixels, cx)
        })
        .flex_shrink_0()
        .size(px(ICON_SIZE))
        .object_fit(ObjectFit::Contain);

        div()
            .id("app-mark")
            .test_support()
            .role(Role::Label)
            .aria_label(NAME)
            .flex()
            .items_center()
            .gap_2()
            .w_full()
            .h(px(ROW_HEIGHT))
            .child(icon)
            .map(|this| {
                if self.rail {
                    this.justify_center()
                } else {
                    this.pl(px(LEFT)).child(
                        div()
                            .text_body()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(NAME),
                    )
                }
            })
    }
}
