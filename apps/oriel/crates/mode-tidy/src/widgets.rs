//! The small parts Tidy's pages share, after the `lw-*` classes Electron Oriel's pages use: the
//! empty state, the card, the caption, a row's icon tile, the key hint inside a button, and a
//! page's main button while its change runs or waits.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Bounds, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, Point, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, TestSupportExt as _, canvas, div, prelude::FluentBuilder as _, px, rems,
};
use oriel_ui::ControlSize as _;
use oriel_ui::TextRole as _;

use crate::format;

/// How long a press on what has just come under the pointer does nothing: it was meant for what
/// went. The default double-click time on macOS and Windows, so a double-click's second press is
/// never the first press on something new.
pub(crate) const ARM_DELAY: Duration = Duration::from_millis(500);

/// Where a press does nothing for a moment: the place something pressed has just gone from, where
/// what has come under the pointer is not what the owner meant. A press anywhere else works.
#[derive(Clone, Copy, Default)]
pub(crate) struct PressGuard(Option<(Instant, Bounds<Pixels>)>);

impl PressGuard {
    /// Holds back presses in `place` for [`ARM_DELAY`] from now.
    pub(crate) fn arm(&mut self, place: Bounds<Pixels>) {
        self.0 = Some((Instant::now() + ARM_DELAY, place));
    }

    pub(crate) fn holds(&self, position: Point<Pixels>) -> bool {
        self.0
            .is_some_and(|(until, place)| Instant::now() < until && place.contains(&position))
    }
}

/// Keeps the bounds its parent was last drawn at, for a [`PressGuard`].
pub(crate) fn measure(bounds: &Rc<Cell<Bounds<Pixels>>>) -> impl IntoElement + use<> {
    let bounds = bounds.clone();
    canvas(move |drawn, _, _| bounds.set(drawn), |_, _, _, _| {})
        .absolute()
        .size_full()
}

/// A centred message for a page with nothing to show (`EmptyState`): an icon, a title, a line
/// under it, and the actions that lead on.
pub fn empty_state(
    id: impl Into<ElementId>,
    icon: Option<IconName>,
    title: impl Into<SharedString>,
    body: Option<AnyElement>,
    actions: Vec<AnyElement>,
    cx: &App,
) -> Div {
    let theme = cx.theme();
    let title: SharedString = title.into();
    div()
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .items_center()
        .justify_center()
        .gap_2()
        .p_10()
        .pb(px(100.))
        .text_center()
        .when_some(icon, |this, icon| {
            this.child(
                Icon::new(icon)
                    .size(px(40.))
                    .text_color(theme.muted_foreground),
            )
        })
        .child(
            div()
                .id(id)
                .test_support()
                .role(Role::Heading)
                .aria_label(title.clone())
                .text_heading()
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .when_some(body, |this, body| {
            this.child(
                div()
                    .max_w(px(520.))
                    .text_body()
                    .text_color(theme.muted_foreground)
                    .child(body),
            )
        })
        .when(!actions.is_empty(), |this| {
            this.child(div().flex().flex_row().gap_2().pt_3().children(actions))
        })
}

/// What a page shows when what it needs couldn't be read: a short title naming what failed
/// ("Couldn't plan the conversion"), the error under it, and Try again.
pub fn error_state(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    error: impl Into<SharedString>,
    on_retry: impl Fn(&mut gpui_kit::Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let id: ElementId = id.into();
    let error: SharedString = error.into();
    empty_state(
        id.clone(),
        Some(IconName::CircleAlert),
        title,
        Some(div().child(error).into_any_element()),
        vec![
            Button::new(SharedString::from(format!("{id}-try-again")))
                .bar_size()
                .outline()
                .quiet_edge(cx)
                .label("Try again")
                .on_click(move |_, window, cx| on_retry(window, cx))
                .into_any_element(),
        ],
        cx,
    )
    .into_any_element()
}

/// A surface lifted from the page (`lw-card`).
pub fn card(cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .flex()
        .flex_col()
        .rounded(theme.radius_lg)
        .bg(theme.group_box)
        .border_1()
        .border_color(theme.border)
}

/// Small grey text (`lw-caption`).
pub fn caption(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_caption()
        .text_color(cx.theme().muted_foreground)
        .child(text.into())
}

/// The 32 px tile an Overview row's icon sits on.
pub fn row_icon(icon: IconName, cx: &App) -> Div {
    let theme = cx.theme();
    div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .size(px(40.))
        .rounded(theme.radius)
        .bg(theme.muted)
        .child(Icon::new(icon).size(px(20.)))
}

/// A key inside a button, as `Kbd` sits in Electron Oriel's buttons: "Tidy up ⌘↩".
pub fn key_hint(keys: &'static str) -> Div {
    div().ml_1().text_caption().opacity(0.85).child(keys)
}

/// A primary action with its key, at the top bar's right, at the bar's size in the house scale.
pub fn primary_action(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    keys: &'static str,
) -> Button {
    Button::new(id)
        .primary()
        .bar_size()
        .label(label)
        .child(key_hint(keys))
}

/// A page's main button while the change it started runs or waits in the queue: still in its
/// place, disabled, with a spinner while it runs and "Queued" while it waits. How far it has got,
/// with its Pause and Stop, is in the activity panel at the window's bottom right. Apply it after
/// the button's own `disabled`.
pub fn while_changing(button: Button, status: Option<crate::actions::ChangeStatus>) -> Button {
    use crate::actions::ChangeStatus;
    match status {
        None => button,
        Some(ChangeStatus::Running) => button.loading(true).disabled(true),
        Some(ChangeStatus::Queued) => button.label("Queued").disabled(true),
    }
}

/// A file as a tile (`MediaTile`): its picture in its own shape on a letterbox, then its name,
/// its folder when `folder` (another tile shows the same name), and its size, with what
/// converting is estimated to leave when `ratio` is known. Tiles grow to fill their row.
/// "clip-3.mp4 · 47%", or just the name where the tool cannot say how far it has got.
pub fn file_and_share(file: &crate::actions::RunningFile) -> String {
    match file.share {
        Some(share) => format!("{} · {}%", file.name, (share * 100.).floor()),
        None => file.name.clone(),
    }
}

/// What marks the tile of the file a change is working on: `doing` and how far along when the tool
/// can say, or that it is paused, on the picture's ground, and a bar along the picture's foot.
pub fn running_badge(doing: &str, file: &crate::actions::RunningFile, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let doing = if file.paused {
        "Paused"
    } else if file.pausing {
        "Pausing"
    } else {
        doing
    };
    let words = match file.share {
        Some(share) => format!("{doing} · {}%", (share * 100.).floor()),
        None if file.paused => doing.to_owned(),
        None => format!("{doing}…"),
    };
    div()
        .id("tile-running")
        .test_support()
        .absolute()
        .inset_0()
        .child(
            div()
                .absolute()
                .left(px(8.))
                .top(px(8.))
                .h_8()
                .px_2()
                .flex()
                .items_center()
                .rounded(theme.radius)
                .bg(gpui_kit::black().opacity(0.75))
                .text_color(gpui_kit::white())
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child(words),
        )
        .when_some(file.share, |this, share| {
            this.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h_1()
                    .bg(gpui_kit::black().opacity(0.6))
                    .child(
                        div()
                            .h_full()
                            .w(gpui_kit::relative(share))
                            .bg(theme.primary),
                    ),
            )
        })
        .into_any_element()
}

pub fn media_tile(
    thumbs: &gpui_kit::Entity<crate::thumbs::Thumbs>,
    row: &oriel_core_tidy::contract::FileRow,
    ratio: Option<f64>,
    folder: bool,
    badge: Option<AnyElement>,
    cx: &mut App,
) -> AnyElement {
    // Covering its tile, as the Library's and View's tiles do: a tile here says which file it is,
    // and a tall picture letterboxed to a sliver would say it badly.
    let picture = crate::thumbs::picture(
        thumbs,
        row,
        512,
        gpui_kit::ObjectFit::Cover,
        cx.theme().radius_lg,
        cx,
    );
    let theme = cx.theme();
    let size = match ratio {
        Some(ratio) => format!(
            "{} → ~{}",
            format::bytes(row.size as f64),
            format::bytes(row.size as f64 * ratio)
        ),
        None => format::bytes(row.size as f64),
    };
    div()
        .id(SharedString::from(format!("tile-{}", row.id)))
        .test_support()
        .aria_label(SharedString::from(row.name.clone()))
        .flex_grow(1.)
        .flex_shrink_0()
        .flex_basis(rems(TILE_BASIS))
        .flex()
        .flex_col()
        .min_w_0()
        .child(
            div()
                .relative()
                .w_full()
                .h(px(168.))
                .rounded(theme.radius_lg)
                .overflow_hidden()
                .bg(theme.muted)
                .child(picture)
                .children(badge),
        )
        .child(
            div()
                .px_0p5()
                .pt(px(6.))
                .child(div().truncate().text_body().child(row.name.clone()))
                .when(folder, |this| {
                    this.child(
                        caption(
                            if row.dir.is_empty() {
                                "The top folder".to_string()
                            } else {
                                row.dir.clone()
                            },
                            cx,
                        )
                        .truncate(),
                    )
                })
                .child(caption(size, cx).truncate()),
        )
        .into_any_element()
}

/// The most a page's column of cards takes: it reads as one piece in a large window, without a
/// card's two ends drifting out of a glance.
pub const PAGE_COLUMN: Pixels = px(960.);

/// The width a media tile starts from before it grows to fill its row.
const TILE_BASIS: f32 = 13.;

/// Tiles in rows that wrap and fill the width. Empty tiles of no height end the last row, so
/// its tiles keep the width of the rows above instead of stretching.
pub fn tile_grid(tiles: Vec<AnyElement>) -> Div {
    div()
        .flex()
        .flex_row()
        .flex_wrap()
        .gap_x_3()
        .gap_y_4()
        .pt_1()
        .pb_6()
        .children(tiles)
        .children((0..12).map(|_| {
            div()
                .flex_grow(1.)
                .flex_shrink_0()
                .flex_basis(rems(TILE_BASIS))
                .h_0()
        }))
}

/// The names more than one of `rows` carries, whose tiles then show their folders.
pub fn repeated_names(
    rows: &[&oriel_core_tidy::contract::FileRow],
) -> std::collections::HashSet<String> {
    let mut seen = std::collections::HashSet::new();
    rows.iter()
        .filter(|row| !seen.insert(row.name.as_str()))
        .map(|row| row.name.clone())
        .collect()
}

/// The reasons files stay as they are, collapsed under their count (`LeftList`).
pub fn left_list(reasons: &[String], cx: &App) -> Div {
    let theme = cx.theme();
    card(cx).children(reasons.iter().enumerate().map(|(index, reason)| {
        div()
            .flex()
            .items_center()
            .h(px(44.))
            .px_4()
            .text_body()
            .when(index > 0, |this| {
                this.border_t_1().border_color(theme.border)
            })
            .child(reason.clone())
    }))
}

/// The last toast Tidy showed, kept for checks: GPUI Kit's notifications do not say what they
/// read.
struct LastToast(SharedString);

impl gpui_kit::Global for LastToast {}

/// Shows a toast, and keeps what it said.
pub fn show_toast(window: &mut gpui_kit::Window, toast: oriel_ui::Toast, cx: &mut App) {
    use oriel_ui::ToastExt as _;
    cx.set_global(LastToast(toast.message().clone()));
    window.show_toast(toast, cx);
}

/// What the last toast said.
pub fn last_toast(cx: &App) -> Option<SharedString> {
    cx.try_global::<LastToast>().map(|last| last.0.clone())
}
