//! A long column of items in a scrolling element of its own, drawn a screen at a time: the items
//! on screen are drawn, and each run of items off it is one empty box of their height, so the
//! column scrolls, clamps and keeps its place as if every item were there.
//!
//! An item's height is learned from the frame that last drew it, by its key, and guessed until
//! then; an item is drawn before it comes on screen, so what shows is always laid out for real.

use std::collections::HashMap;
use std::hash::Hash;

use gpui_kit::{AnyElement, IntoElement as _, ScrollHandle, Styled as _, Window, div, px};

/// One child of the scrolling element: an item, or the room of a run of items not drawn.
pub enum Piece {
    Item(usize),
    Room(f32),
}

impl Piece {
    /// The box standing for items not drawn; it never shrinks, so it keeps their room.
    pub fn room(height: f32) -> AnyElement {
        div().flex_shrink_0().h(px(height)).into_any_element()
    }
}

/// The scroll and the heights learned of one column.
pub struct Windowed<K> {
    scroll: ScrollHandle,
    heights: HashMap<K, f32>,
    /// The key of each child the last frame drew, or none for a room.
    drawn: Vec<Option<K>>,
}

impl<K: Clone + Eq + Hash> Default for Windowed<K> {
    fn default() -> Self {
        Self {
            scroll: ScrollHandle::new(),
            heights: HashMap::new(),
            drawn: Vec::new(),
        }
    }
}

impl<K: Clone + Eq + Hash> Windowed<K> {
    /// The scroll the column's element tracks.
    pub fn scroll(&self) -> &ScrollHandle {
        &self.scroll
    }

    /// What to draw of `keys`, in order, given each item's guessed height until one is learned:
    /// the items within the screen, rooms for the rest; and the items within `near` pixels past
    /// the screen, above and below, whose pictures are worth asking for ahead. `before` is the
    /// room the column's element leaves above its first item.
    ///
    /// The screen is the window's height, which the column never exceeds, so a frame after a
    /// resize draws enough even before the column's own bounds have caught up.
    pub fn plan(
        &mut self,
        keys: &[K],
        guess: impl Fn(usize) -> f32,
        before: f32,
        near: f32,
        window: &Window,
    ) -> (Vec<Piece>, Vec<usize>) {
        // What the last frame laid out, as the element measured it.
        for (child, key) in self.drawn.iter().enumerate() {
            if let (Some(key), Some(bounds)) = (key, self.scroll.bounds_for_item(child)) {
                self.heights
                    .insert(key.clone(), f32::from(bounds.size.height));
            }
        }
        let height = |index: usize| {
            self.heights
                .get(&keys[index])
                .copied()
                .unwrap_or_else(|| guess(index))
        };
        let screen = f32::from(window.viewport_size().height);
        let content: f32 = (0..keys.len()).map(height).sum();
        let bounds = f32::from(self.scroll.bounds().size.height);
        let most = if bounds > 0. {
            (before + content - bounds).max(0.)
        } else {
            before + content
        };
        let top = (-f32::from(self.scroll.offset().y)).clamp(0., most) - before;
        let bottom = top + screen;
        let mut pieces = Vec::new();
        let mut nearby = Vec::new();
        let mut room = 0.;
        let mut at = 0.;
        for index in 0..keys.len() {
            let tall = height(index);
            let (start, end) = (at, at + tall);
            at = end;
            if end > top && start < bottom {
                if room > 0. {
                    pieces.push(Piece::Room(room));
                    room = 0.;
                }
                pieces.push(Piece::Item(index));
            } else {
                room += tall;
                if end > top - near && start < bottom + near {
                    nearby.push(index);
                }
            }
        }
        if room > 0. {
            pieces.push(Piece::Room(room));
        }
        self.drawn = pieces
            .iter()
            .map(|piece| match piece {
                Piece::Item(index) => Some(keys[*index].clone()),
                Piece::Room(_) => None,
            })
            .collect();
        (pieces, nearby)
    }
}
