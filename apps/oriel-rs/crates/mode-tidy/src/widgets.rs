//! The small parts Tidy's pages share, after the `lw-*` classes Electron Oriel's pages use: the
//! empty state, the card, the caption, a row's icon tile, the key hint inside a button, and a
//! page's main button while its change runs or waits.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon};
use gpui_kit::{
    AnyElement, App, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, div, prelude::FluentBuilder as _, px, rems,
};

use crate::format;

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
                    .size(px(32.))
                    .text_color(theme.muted_foreground),
            )
        })
        .child(
            div()
                .id(id)
                .test_support()
                .role(Role::Heading)
                .aria_label(title.clone())
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .when_some(body, |this, body| {
            this.child(
                div()
                    .max_w(px(420.))
                    .text_sm()
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
                .outline()
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
        .text_xs()
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
        .size(px(32.))
        .rounded(theme.radius)
        .bg(theme.muted)
        .child(Icon::new(icon).size(px(16.)))
}

/// A key inside a button, as `Kbd` sits in Electron Oriel's buttons: "Tidy up ⌘↩".
pub fn key_hint(keys: &'static str) -> Div {
    div().ml_1().text_xs().opacity(0.6).child(keys)
}

/// A primary action with its key, at the top bar's right.
pub fn primary_action(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    keys: &'static str,
) -> Button {
    Button::new(id).primary().label(label).child(key_hint(keys))
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
pub fn media_tile(
    thumbs: &gpui_kit::Entity<crate::thumbs::Thumbs>,
    row: &oriel_core_tidy::contract::FileRow,
    ratio: Option<f64>,
    folder: bool,
    cx: &mut App,
) -> AnyElement {
    let picture = crate::thumbs::picture(thumbs, row, 320, gpui_kit::ObjectFit::Contain, cx);
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
                .w_full()
                .h(px(132.))
                .rounded(theme.radius_lg)
                .overflow_hidden()
                .bg(theme.muted)
                .child(picture),
        )
        .child(
            div()
                .px_0p5()
                .pt(px(6.))
                .child(div().truncate().text_sm().child(row.name.clone()))
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

/// The width a media tile starts from before it grows to fill its row.
const TILE_BASIS: f32 = 11.;

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
            .text_size(px(13.))
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
