//! Strips that move the window, as `.lw-drag` does in Electron Oriel. The title bar is
//! transparent, so the app owns dragging: a press then a move starts a window move, and a double
//! click does what the system's title bar setting says.

use gpui_kit::component::InteractiveElementExt as _;
use gpui_kit::{
    AnyElement, App, Div, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement, RenderOnce, StyleRefinement, Styled, Window, WindowControlArea, div,
};

/// A region of the window's top strip. Children that are pressable stop the press from
/// reaching it, as GPUI Kit's buttons do.
#[derive(IntoElement)]
pub struct DragStrip {
    id: ElementId,
    base: Div,
    children: Vec<AnyElement>,
}

struct DragState {
    should_move: bool,
}

impl DragStrip {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            base: div(),
            children: Vec::new(),
        }
    }
}

impl Styled for DragStrip {
    fn style(&mut self) -> &mut StyleRefinement {
        self.base.style()
    }
}

impl ParentElement for DragStrip {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for DragStrip {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state =
            window.use_keyed_state(self.id.clone(), cx, |_, _| DragState { should_move: false });

        self.base
            .id(self.id)
            .window_control_area(WindowControlArea::Drag)
            .on_double_click(|_, window, _| window.titlebar_double_click())
            .on_mouse_down(
                MouseButton::Left,
                window.listener_for(&state, |state, _, _, _| state.should_move = true),
            )
            .on_mouse_up(
                MouseButton::Left,
                window.listener_for(&state, |state, _, _, _| state.should_move = false),
            )
            .on_mouse_down_out(window.listener_for(&state, |state, _, _, _| {
                state.should_move = false;
            }))
            .on_mouse_move(window.listener_for(&state, |state, _, window, _| {
                if state.should_move {
                    state.should_move = false;
                    window.start_window_move();
                }
            }))
            .children(self.children)
    }
}
