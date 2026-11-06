//! The line under Duplicates' scopes while Spot variants has not finished comparing some sets.
//! They wait out of every queue, so that nothing can be removed or marked as not duplicates on
//! what is not known yet. When no analysis is running to finish them, it offers to run one, since a
//! stopped analysis would otherwise leave them waiting until Tidy next opens.

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::component::button::Button;
use gpui_kit::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _, Role,
    StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div,
    prelude::FluentBuilder as _,
};
use oriel_ui::ControlSize as _;

use crate::format;
use crate::state::TidyState;

/// The line for `count` sets being checked, or nothing when there are none.
pub fn render(state: &Entity<TidyState>, count: i64, cx: &App) -> Option<AnyElement> {
    if count == 0 {
        return None;
    }
    let running = {
        let state = state.read(cx);
        state.analysis().is_some() || state.scan().is_some()
    };
    let sets = format::plural(count, "set");
    let text = if running {
        format!("Checking {sets}")
    } else {
        format!("{sets} not checked yet")
    };
    let state = state.clone();
    Some(
        div()
            .id("scope-checking")
            .test_support()
            .role(Role::Status)
            .aria_label(text.clone())
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .whitespace_nowrap()
            .text_sm()
            .text_color(cx.theme().muted_foreground)
            .child(text)
            .when(!running, |line| {
                line.child(
                    Button::new("duplicates-check-now")
                        .row_size()
                        .outline()
                        .quiet_edge(cx)
                        .label("Check now")
                        .on_click(move |_, window, cx| {
                            state.update(cx, |state, cx| {
                                if let Some(root_id) = state.root_id() {
                                    state.start_analysis(root_id, window, cx);
                                }
                            });
                        }),
                )
            })
            .into_any_element(),
    )
}
