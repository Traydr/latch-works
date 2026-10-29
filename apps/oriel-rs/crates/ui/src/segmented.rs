//! A segmented control in the house style (`.lw-seg`): a 32 px track with the selected item
//! raised on it. The mode switcher and Settings' theme choice use it.
//!
//! Each item is a toggle button, pressed while selected, as Electron Oriel's `aria-pressed`
//! buttons are, so VoiceOver reads the group's name, then each choice and whether it is the one.
//! GPUI Kit's unstyled button owns the behaviour (focus, Return and Space, the accessible role);
//! the presentation here is the house's.

use std::rc::Rc;

use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, TestSupportExt as _, Toggled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::layout::KeepsFocus as _;

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// The track's height, and its items' (two less on each side).
const TRACK_HEIGHT: f32 = 32.;
const ITEM_HEIGHT: f32 = 28.;

#[derive(IntoElement)]
pub struct Segmented {
    id: ElementId,
    label: SharedString,
    items: Vec<SegmentedItem>,
    fill: bool,
}

impl Segmented {
    /// A segmented control that assistive technology names `label`, as a group.
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            items: Vec::new(),
            fill: false,
        }
    }

    pub fn item(mut self, item: SegmentedItem) -> Self {
        self.items.push(item);
        self
    }

    pub fn items(mut self, items: impl IntoIterator<Item = SegmentedItem>) -> Self {
        self.items.extend(items);
        self
    }

    /// Stretches the track to its container and shares the width equally among the items, as
    /// the mode switcher does across the sidebar.
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }
}

/// One choice of a [`Segmented`].
pub struct SegmentedItem {
    id: ElementId,
    label: SharedString,
    icon: Option<Icon>,
    selected: bool,
    tooltip: Option<SharedString>,
    description: Option<SharedString>,
    trailing: Option<AnyElement>,
    on_click: Option<ClickHandler>,
}

impl SegmentedItem {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            selected: false,
            tooltip: None,
            description: None,
            trailing: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: impl Into<Icon>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Shown on hover; a shortcut, or what the item stands for.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Read by assistive technology after the label, such as the work a mode is doing.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Drawn after the label, such as a mode's activity mark.
    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Segmented {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let fill = self.fill;
        div()
            .id(self.id)
            .test_support()
            .role(Role::Group)
            .aria_label(self.label)
            .flex()
            .flex_row()
            .items_center()
            .h(px(TRACK_HEIGHT))
            .p(px(2.))
            .gap(px(2.))
            .rounded(theme.radius)
            .bg(theme.tab_bar)
            .when(fill, |this| this.w_full())
            .children(
                self.items
                    .into_iter()
                    .map(|item| render_item(item, fill, cx)),
            )
    }
}

fn render_item(item: SegmentedItem, fill: bool, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let selected = item.selected;
    let tooltip = item.tooltip;
    let on_click = item.on_click;

    gpui_kit::base::Button::new(item.id)
        .keeps_focus_on_press()
        .accessibility_label(item.label.clone())
        .aria_toggled(if selected {
            Toggled::True
        } else {
            Toggled::False
        })
        .when_some(item.description, |this, description| {
            this.aria_description(description)
        })
        .relative()
        .flex_row()
        .gap(px(6.))
        .h(px(ITEM_HEIGHT))
        .map(|this| if fill { this.flex_1() } else { this.px_3() })
        // The keyboard's focus line sits inside the item, as `.lw-seg-item`'s inset outline
        // does, so the border is always there and only its colour changes.
        .border_2()
        .border_color(theme.transparent)
        .rounded(theme.radius - px(2.))
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.tab_foreground)
        .hover(|style| style.text_color(theme.tab_active_foreground))
        .focus_visible(|style| style.border_color(theme.ring))
        .when(selected, |this| {
            this.bg(theme.tab_active)
                .text_color(theme.tab_active_foreground)
                .shadow_xs()
        })
        .when_some(tooltip, |this, tooltip| {
            this.tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
            })
        })
        .when_some(item.icon, |this, icon| this.child(icon.size(px(14.))))
        .child(item.label)
        .children(item.trailing)
        .when_some(on_click, |this, on_click| {
            this.on_click(move |event, window, cx| on_click(event, window, cx))
        })
}
