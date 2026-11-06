//! The house's control scale: how big a button, a checkbox or a menu row is, by its role, so
//! every mode sizes its controls by one rule rather than one call site at a time.
//!
//! The owner found the controls and the type too small, twice. The cause was the theme's 13 px
//! base font, which is also the window's rem: GPUI Kit sizes its controls in rems for a 16 px
//! base, so its medium button came out 26 px high with an 11.4 px label. The base is now that
//! 16 px, so every rem helper lands on a whole pixel and GPUI Kit's own scale is the one it was
//! drawn for. Text takes a role here ([`TextRole`]) and a control its role's frame, so a change
//! of mind is one number in this file.
//!
//! The Design Guides ask for pointer targets "comfortably sized even in a dense layout", for
//! extra compact never as the automatic choice, and for typography, icon and frame to change
//! together through the component's size. So every control takes GPUI Kit's large size, and its
//! role sets the frame:
//!
//! | Role | Frame | Label | Icon |
//! | --- | --- | --- | --- |
//! | Top bar, floating toolbar, a page's or a dialog's command ([`ControlSize::bar_size`]) | 40 px; icon-only 40 × 40 | 16 px | 24 px |
//! | A page's primary action, such as Tidy up or Plan ([`ControlSize::page_size`]) | 44 px | 16 px | 24 px |
//! | The commands that end every set in Duplicates ([`ControlSize::decision_size`]) | 48 px | 16 px | 24 px |
//! | An action inline in a dense row or a panel's header ([`ControlSize::row_size`]) | 32 px; icon-only 32 × 32 | 15 px | 24 px |
//! | A checkbox ([`checkbox_target`]) | an 18 px box in a 32 px target | | |
//! | A switch | GPUI Kit's large, 44 × 24 px | | |
//! | A row of a popover or menu ([`MENU_ROW_HEIGHT`]) | 40 px | 15 px | |
//!
//! | Text role | Size | For |
//! | --- | --- | --- |
//! | [`TEXT_TITLE`] | 20 px | A page's title in its top bar |
//! | [`TEXT_HEADING`] | 18 px | A section's or a dialog's heading |
//! | [`TEXT_BODY`] | 15 px | Rows, menus, names: what a page is made of |
//! | GPUI Kit's `text_sm` | 14 px | A second line, a tile's folder |
//! | [`TEXT_CAPTION`] | 13 px | Counts, dates, a tile's facts: the smallest the app draws |
//!
//! **The floor.** No text the app draws is under [`MIN_TEXT`], 13 px, and nothing clickable the
//! app draws is under [`MIN_TARGET`], 32 px. These exceptions are GPUI Kit's own and cannot be
//! reached from here: the 12 px key caps in `Kbd` and in a tooltip's shortcut, and the 20 px close
//! cross that shows on a toast under the pointer. One glyph is smaller by design: the 11 px figure
//! inside the player's skip-5 icon, part of the icon rather than text to read. So `text_xs`,
//! `.small()` and `.xsmall()` are for spinners and icons only, never for text or a control.

use gpui_kit::component::button::Button;
use std::rc::Rc;

use gpui_kit::component::menu::PopupMenuItem;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, FocusableExt as _, Sizable, Size, checkbox::Checkbox,
    switch::Switch,
};
use gpui_kit::{
    App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, RenderOnce,
    SharedString, StatefulInteractiveElement as _, Styled, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, px,
};

/// A page's title in its top bar.
pub const TEXT_TITLE: Pixels = px(20.);

/// A section's or a dialog's heading.
pub const TEXT_HEADING: Pixels = px(18.);

/// What a page is made of: rows, menus, names.
pub const TEXT_BODY: Pixels = px(15.);

/// Counts, dates and a tile's facts: the smallest text the app draws.
pub const TEXT_CAPTION: Pixels = MIN_TEXT;

/// The smallest text the app draws.
pub const MIN_TEXT: Pixels = px(13.);

/// Gives text its role in the house scale.
pub trait TextRole: Styled + Sized {
    fn text_title(self) -> Self {
        self.text_size(TEXT_TITLE)
    }

    fn text_heading(self) -> Self {
        self.text_size(TEXT_HEADING)
    }

    fn text_body(self) -> Self {
        self.text_size(TEXT_BODY)
    }

    fn text_caption(self) -> Self {
        self.text_size(TEXT_CAPTION)
    }
}

impl<T: Styled> TextRole for T {}

/// An outline button's edge in the dark theme, white at 24%, and in the light.
const OUTLINE_EDGE_DARK: u32 = 0xffffff3d;
const OUTLINE_EDGE_LIGHT: u32 = 0xc4c4ccff;

/// The frame of a control in a top bar or a toolbar, and of a page's or dialog's command.
pub const BAR_HEIGHT: Pixels = px(40.);

/// The frame of a page's primary action.
pub const PAGE_HEIGHT: Pixels = px(44.);

/// The frame of the commands that end every set in Duplicates, the app's most pressed.
pub const DECISION_HEIGHT: Pixels = px(48.);

/// The frame of an action inline in a dense row, and the smallest target the app draws.
pub const ROW_HEIGHT: Pixels = px(32.);

/// The smallest pointer target the app draws.
pub const MIN_TARGET: Pixels = ROW_HEIGHT;

/// A row of a popover or a menu.
pub const MENU_ROW_HEIGHT: Pixels = px(40.);

/// A switch at GPUI Kit's large size, whose track is 44 × 24 px and takes clicks only there, in a
/// target at the floor: the strips above and below the track press it too.
#[derive(IntoElement)]
pub struct HouseSwitch {
    id: ElementId,
    checked: bool,
    disabled: bool,
    label: Option<SharedString>,
    on_click: Option<OnToggle>,
}

type OnToggle = Rc<dyn Fn(&bool, &mut Window, &mut App)>;

pub fn switch(id: impl Into<ElementId>) -> HouseSwitch {
    HouseSwitch {
        id: id.into(),
        checked: false,
        disabled: false,
        label: None,
        on_click: None,
    }
}

impl HouseSwitch {
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn accessibility_label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for HouseSwitch {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let next = !self.checked;
        let strip = |id: ElementId, handler: Option<OnToggle>| {
            div()
                .id(id)
                .absolute()
                .left_0()
                .right_0()
                .h_1()
                .when(handler.is_some(), |this| this.cursor_pointer())
                .when_some(handler, |this, handler| {
                    this.on_click(move |_, window, cx| handler(&next, window, cx))
                })
        };
        let usable = self.on_click.clone().filter(|_| !self.disabled);
        let inner = Switch::new(self.id.clone())
            .with_size(Size::Large)
            .checked(self.checked)
            .disabled(self.disabled)
            .when_some(self.label, |this, label| this.accessibility_label(label))
            .when_some(self.on_click, |this, handler| {
                this.on_click(move |checked, window, cx| handler(checked, window, cx))
            });
        div()
            .id((self.id.clone(), "target"))
            .test_support()
            .relative()
            .flex_shrink_0()
            .flex()
            .items_center()
            .h(MIN_TARGET)
            .child(inner)
            .child(strip((self.id.clone(), "above").into(), usable.clone()).top_0())
            .child(strip((self.id, "below").into(), usable).bottom_0())
    }
}

/// A row of a popup menu at the house scale's height: GPUI Kit's own items are 26 px, and only one
/// made of an element can be taller. VoiceOver reads the row by its label, as it reads a kit item.
pub fn menu_row(label: impl Into<SharedString>) -> PopupMenuItem {
    let label: SharedString = label.into();
    PopupMenuItem::element(move |_, _| {
        div()
            .id(ElementId::Name(label.clone()))
            .test_support()
            .aria_label(label.clone())
            .flex()
            .items_center()
            .h(MENU_ROW_HEIGHT)
            .text_body()
            .child(label.clone())
    })
}

/// Sizes a control by its role in the house scale.
pub trait ControlSize: Sized {
    /// A control in a top bar or a floating toolbar, or a page's or a dialog's command: a
    /// 40 px frame, square when it is an icon alone.
    fn bar_size(self) -> Self;

    /// A page's primary action, such as Tidy up or Push: a 44 px frame.
    fn page_size(self) -> Self;

    /// The commands that end a set in Duplicates: a 48 px frame.
    fn decision_size(self) -> Self;

    /// An action inline in a dense row or a panel's header, such as a row's Restore or a
    /// panel's close: a 32 px frame, square when it is an icon alone, and its label a size
    /// down from a bar's so it sits level with the row's text.
    fn row_size(self) -> Self;

    /// An outline button's edge, lighter than an empty field's or checkbox's: its label says what
    /// it is, and a stack of them should not read as a stack of boxes.
    fn quiet_edge(self, cx: &App) -> Self;
}

/// An outline button that opens a popover. GPUI Kit fills an open outline button with the field
/// edge's colour, too heavy behind its words in the light theme, so this takes a lighter fill.
#[derive(IntoElement)]
pub struct OutlineTrigger {
    button: Button,
    open: bool,
}

impl OutlineTrigger {
    pub fn new(button: Button) -> Self {
        Self {
            button,
            open: false,
        }
    }
}

impl gpui_kit::component::Selectable for OutlineTrigger {
    fn selected(mut self, selected: bool) -> Self {
        self.open = selected;
        self
    }

    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for OutlineTrigger {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        use gpui_kit::component::Selectable as _;
        let fill = cx.theme().secondary_active;
        self.button
            .selected(self.open)
            .when(self.open, |this| this.bg(fill))
    }
}

/// For every sized GPUI Kit control: a button, and an input beside one, so a search field
/// lines up with the buttons in its bar.
impl<T: Sizable + Styled> ControlSize for T {
    fn quiet_edge(self, cx: &App) -> Self {
        self.border_color(if cx.theme().is_dark() {
            gpui_kit::rgba(OUTLINE_EDGE_DARK)
        } else {
            gpui_kit::rgba(OUTLINE_EDGE_LIGHT)
        })
    }

    fn bar_size(self) -> Self {
        self.with_size(Size::Large).h(BAR_HEIGHT).min_w(BAR_HEIGHT)
    }

    fn page_size(self) -> Self {
        self.with_size(Size::Large)
            .h(PAGE_HEIGHT)
            .min_w(PAGE_HEIGHT)
            .px_5()
    }

    fn decision_size(self) -> Self {
        self.with_size(Size::Large)
            .h(DECISION_HEIGHT)
            .min_w(DECISION_HEIGHT)
            .px_6()
    }

    fn row_size(self) -> Self {
        self.with_size(Size::Large)
            .h(ROW_HEIGHT)
            .min_w(ROW_HEIGHT)
            .text_size(TEXT_BODY)
    }
}

/// The focus ring's colour on a ground that stays dark in either theme: the viewers' stages, the
/// loupe's, and a chip over a picture.
pub const STAGE_RING: u32 = 0xc4b5fd;

/// A button on a stage that stays dark in either theme: light glyphs, and the ring in the colour
/// that shows there. The theme's ring is for the page's own ground, and in the light theme is
/// nearly black.
pub fn on_dark_stage(button: Button) -> Button {
    button
        .focus_ring(false)
        .border_2()
        .border_color(gpui_kit::transparent_black())
        .text_color(gpui_kit::white())
        .focus_visible(|style| style.border_color(gpui_kit::rgb(STAGE_RING)))
}

/// A checkbox at GPUI Kit's large size, an 18 px box, padded to a 32 px target so a press beside
/// the box still lands. A checkbox with a label keeps the label's own target too.
pub fn checkbox_target(checkbox: Checkbox) -> Checkbox {
    checkbox.with_size(Size::Large).p(px(7.))
}
