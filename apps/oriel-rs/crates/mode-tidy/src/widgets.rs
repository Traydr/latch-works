//! The small parts Tidy's pages share, after the `lw-*` classes Electron Oriel's pages use: the
//! empty state, the card, the caption, a row's icon tile, the key hint inside a button, and the
//! progress of a running change with its Stop.

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, div, prelude::FluentBuilder as _, px,
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

/// A running change's Pause, or Resume once paused, for [`run_progress`].
pub type OnPause = Box<dyn Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut App)>;

/// What a running change shows where its button was (`RunProgress`): what it does, how far it
/// has got, Pause where the page allows it (`pause`, and whether it is paused now), and Stop.
pub fn run_progress(
    id: &'static str,
    label: SharedString,
    done: u64,
    total: u64,
    pause: Option<(bool, OnPause)>,
    on_stop: impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut App) + 'static,
    cx: &App,
) -> Div {
    let counted = if total > 0 {
        format!(
            "{label} {} of {}",
            format::count(done as i64),
            format::count(total as i64)
        )
    } else {
        label.to_string()
    };
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .child(Spinner::new().small())
        .child(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .w(px(180.))
                .child(div().text_xs().truncate().child(counted))
                .child(
                    Progress::new(SharedString::from(format!("{id}-progress")))
                        .value(if total > 0 {
                            done.min(total) as f32 / total as f32 * 100.
                        } else {
                            0.
                        })
                        .loading(total == 0),
                ),
        )
        .children(pause.map(|(paused, on_pause)| {
            Button::new(SharedString::from(format!("{id}-pause")))
                .ghost()
                .small()
                .icon(Icon::new(if paused {
                    IconName::Play
                } else {
                    IconName::Pause
                }))
                .accessibility_label(if paused { "Resume" } else { "Pause" })
                .tooltip(if paused { "Resume" } else { "Pause" })
                .on_click(on_pause)
        }))
        .child(
            Button::new(SharedString::from(format!("{id}-stop")))
                .ghost()
                .small()
                .icon(Icon::new(IconName::Square))
                .accessibility_label("Stop")
                .tooltip("Stop (finished steps stay done and can be undone)")
                .on_click(on_stop),
        )
        .text_color(cx.theme().foreground)
}

/// A file as a tile (`MediaTile`): its picture in its own shape on a letterbox, then its name
/// and size, with what converting is estimated to leave when `ratio` is known.
pub fn media_tile(
    thumbs: &gpui_kit::Entity<crate::thumbs::Thumbs>,
    row: &oriel_core_tidy::contract::FileRow,
    ratio: Option<f64>,
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
        .w(px(176.))
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
                .child(div().truncate().text_size(px(13.)).child(row.name.clone()))
                .child(caption(size, cx).truncate()),
        )
        .into_any_element()
}

/// Tiles in rows that wrap, 176 px wide.
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
}

/// The running change a page started, shown where its main button was.
pub fn change_progress(
    state: &gpui_kit::Entity<crate::state::TidyState>,
    source: &str,
    id: &'static str,
    cx: &App,
) -> Option<AnyElement> {
    let change = state.read(cx).change_for(source)?;
    let progress = change.progress(cx);
    let label = if progress.phase().is_empty() {
        change.name(cx)
    } else {
        progress.phase().clone()
    };
    let stopper = state.clone();
    let pauser = state.clone();
    let pause: OnPause = Box::new(move |_, _, cx| {
        pauser.update(cx, |state, cx| state.toggle_change_pause(cx));
    });
    Some(
        run_progress(
            id,
            label,
            progress.done(),
            progress.total(),
            Some((progress.is_paused(), pause)),
            move |_, _, cx| stopper.update(cx, |state, cx| state.stop_change(cx)),
            cx,
        )
        .into_any_element(),
    )
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
