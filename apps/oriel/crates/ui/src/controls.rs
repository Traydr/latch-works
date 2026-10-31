//! The house's control scale: how big a button, a checkbox or a menu row is, by its role, so
//! every mode sizes its controls by one rule rather than one call site at a time.
//!
//! The owner found the controls too small. The cause is the theme's 13 px base font (Electron
//! Oriel's `lw-*` tokens), which is also the window's rem: GPUI Kit sizes its controls in rems
//! for a 16 px base, so its medium button came out 26 px high with an 11.4 px label and a 13 px
//! icon, and its small and extra-small ones 19.5 and 16 px.
//!
//! The Design Guides ask for pointer targets "comfortably sized even in a dense layout", for
//! extra compact never as the automatic choice, and for typography, icon and frame to change
//! together through the component's size. So every control here takes GPUI Kit's large size,
//! whose label is the theme's 13 px body type and whose icon is 19.5 px, and its role sets the
//! frame, one step up GPUI Kit's 20, 24 and 32 px ladder from what the 13 px rem gave:
//!
//! | Role | Frame |
//! | --- | --- |
//! | Top bar, floating toolbar, a page's or a dialog's command ([`ControlSize::bar_size`]) | 32 px; icon-only 32 × 32 |
//! | A page's primary action, such as Tidy up or Plan ([`ControlSize::page_size`]) | 36 px |
//! | An action inline in a dense row or a panel's header ([`ControlSize::row_size`]) | 26 px; icon-only 26 × 26 |
//! | A checkbox ([`checkbox_target`]) | a 14.6 px box in a 28 px target |
//! | A switch | GPUI Kit's medium, 36 × 20 px |
//! | A row of a popover or menu the app draws ([`MENU_ROW_HEIGHT`]) | 32 px |
//!
//! Nothing clickable is smaller than [`MIN_TARGET`]. The frames are in pixels, as the theme's
//! Electron tokens are: at a 13 px rem, GPUI Kit's rem steps land between pixels.

use gpui_kit::component::{Sizable, Size, checkbox::Checkbox};
use gpui_kit::{Pixels, Styled, px};

/// The frame of a control in a top bar or a toolbar, and of a page's or dialog's command.
pub const BAR_HEIGHT: Pixels = px(32.);

/// The frame of a page's primary action.
pub const PAGE_HEIGHT: Pixels = px(36.);

/// The frame of an action inline in a dense row, and the smallest target the app draws.
pub const ROW_HEIGHT: Pixels = px(26.);

/// The smallest pointer target the app draws.
pub const MIN_TARGET: Pixels = ROW_HEIGHT;

/// A row of a popover or a menu the app draws itself, such as View's sort menu. Menus built on
/// GPUI Kit's `PopupMenu` keep its own rows, as the Design Guides ask a component family to keep
/// its geometry.
pub const MENU_ROW_HEIGHT: Pixels = px(32.);

/// Sizes a control by its role in the house scale.
pub trait ControlSize: Sized {
    /// A control in a top bar or a floating toolbar, or a page's or a dialog's command: a
    /// 32 px frame, square when it is an icon alone.
    fn bar_size(self) -> Self;

    /// A page's primary action, such as Tidy up or Push: a 36 px frame.
    fn page_size(self) -> Self;

    /// An action inline in a dense row or a panel's header, such as a row's Restore or a
    /// panel's close: a 26 px frame, square when it is an icon alone.
    fn row_size(self) -> Self;
}

/// For every sized GPUI Kit control: a button, and an input beside one, so a search field
/// lines up with the buttons in its bar.
impl<T: Sizable + Styled> ControlSize for T {
    fn bar_size(self) -> Self {
        self.with_size(Size::Large).h(BAR_HEIGHT).min_w(BAR_HEIGHT)
    }

    fn page_size(self) -> Self {
        self.with_size(Size::Large)
            .h(PAGE_HEIGHT)
            .min_w(PAGE_HEIGHT)
            .px_4()
    }

    fn row_size(self) -> Self {
        self.with_size(Size::Large).h(ROW_HEIGHT).min_w(ROW_HEIGHT)
    }
}

/// A checkbox at GPUI Kit's large size, a 14.6 px box, padded to a 28 px target so a press
/// beside the box still lands. A checkbox with a label keeps the label's own target too.
pub fn checkbox_target(checkbox: Checkbox) -> Checkbox {
    checkbox.with_size(Size::Large).p(px(6.75))
}
