//! Keeps the keyboard's focus in sight. Tab moves focus to the next control wherever it is, and GPUI
//! does not scroll to it: in a list longer than its window the ring would go out of sight, and the
//! owner with it.
//!
//! A row in a scroller tracks a focus handle of its own, which takes no Tab, and holds a
//! [`FocusReveal::watcher`]; [`FocusReveal::keep`] wraps a row in both. When focus lands on anything
//! inside the row, the watcher scrolls the row into view, unless the owner has scrolled since it
//! last did: a wheel scroll stays where the owner put it.

use std::cell::RefCell;
use std::rc::Rc;

use gpui_kit::{
    AnyElement, App, Context, ElementId, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, Point, ScrollHandle, SharedString, Styled as _, Window, canvas,
    div, point, px,
};

type Shown = (FocusHandle, Point<Pixels>);

/// What one scroller's rows share.
#[derive(Clone)]
pub struct FocusReveal {
    scroll: ScrollHandle,
    /// The row focus is in, while it is, and where the scroller stood when it was last seen to.
    shown: Rc<RefCell<Option<Shown>>>,
    /// What the scroller keeps out of a row's way at its foot, such as a fade.
    foot: Pixels,
}

impl FocusReveal {
    pub fn new(scroll: &ScrollHandle, foot: Pixels) -> Self {
        Self {
            scroll: scroll.clone(),
            shown: Rc::default(),
            foot,
        }
    }

    /// This reveal over `scroll`, which is another handle whenever the page around the scroller
    /// changes shape.
    pub fn over(&self, scroll: &ScrollHandle) -> Self {
        Self {
            scroll: scroll.clone(),
            ..self.clone()
        }
    }

    /// The reveal of the scroller `key` names on this page, which lasts as long as it is drawn.
    pub fn of(
        key: impl Into<SharedString>,
        foot: Pixels,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let key: SharedString = key.into();
        window
            .use_keyed_state(key, cx, |_, _: &mut Context<Self>| {
                Self::new(&ScrollHandle::new(), foot)
            })
            .read(cx)
            .clone()
    }

    /// The handle to give the scroller's `track_scroll`.
    pub fn scroll(&self) -> &ScrollHandle {
        &self.scroll
    }

    /// `row`, kept in sight whenever focus is on anything inside it. `key` tells it from the other
    /// rows of its page.
    pub fn keep(
        &self,
        key: impl Into<SharedString>,
        row: impl IntoElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let key: SharedString = key.into();
        let focus = window
            .use_keyed_state(
                ElementId::Name(format!("keep-in-sight-{key}").into()),
                cx,
                |_, cx: &mut Context<FocusHandle>| cx.focus_handle(),
            )
            .read(cx)
            .clone();
        div()
            .track_focus(&focus)
            .relative()
            .w_full()
            .child(row)
            .child(self.watcher(&focus))
            .into_any_element()
    }

    /// An invisible child of the row, which must be positioned, that watches `row`'s handle.
    pub fn watcher(&self, row: &FocusHandle) -> impl IntoElement + use<> {
        let (reveal, row) = (self.clone(), row.clone());
        canvas(
            |_, _, _| {},
            move |bounds, (), window, cx| {
                let offset = reveal.scroll.offset();
                let known = reveal
                    .shown
                    .borrow()
                    .as_ref()
                    .filter(|(shown, _)| *shown == row)
                    .map(|(_, at)| *at);
                if !row.contains_focused(window, cx) {
                    if known.is_some() {
                        reveal.shown.replace(None);
                    }
                    return;
                }
                if known.is_some_and(|at| at != offset) {
                    return;
                }
                let view = reveal.scroll.bounds();
                let (top, bottom) = (view.top(), view.bottom() - reveal.foot);
                let move_by = if bounds.top() < top || bounds.size.height > bottom - top {
                    top - bounds.top()
                } else if bounds.bottom() > bottom {
                    bottom - bounds.bottom()
                } else {
                    reveal.shown.replace(Some((row.clone(), offset)));
                    return;
                };
                let last = -reveal.scroll.max_offset().y;
                let moved = point(offset.x, (offset.y + move_by).max(last).min(px(0.)));
                reveal.scroll.set_offset(moved);
                reveal.shown.replace(Some((row.clone(), moved)));
                crate::redraw::refresh_next_frame(window);
            },
        )
        // At the row's own corner: without one, an absolute child stands where the next in-flow
        // child would, one row further down, and the row is measured as if it were there.
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }
}
