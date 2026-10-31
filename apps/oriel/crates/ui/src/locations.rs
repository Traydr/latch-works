//! The location switcher at the top of every mode's sidebar: the folder (or Sync's profile) the
//! mode works on, with its menu of the other places the modes work on.
//!
//! Each mode keeps its own selection, and fills the menu with its own places first (View's
//! folder, Tidy's folders, Sync's profiles), then the folders the other modes use that it does
//! not ([`shared_locations`]), then its own add action. The list is what is shared: every row
//! shows, quietly, which modes use its folder. The menu is as wide as the switcher, the full
//! width of the sidebar inside its margins, in the rail too.

use std::path::Path;
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::base::ElementExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::{ActiveTheme as _, Icon};
use gpui_kit::{
    App, Bounds, Context, ElementId, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, ParentElement as _, Pixels,
    PlatformInput, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px,
};

use crate::folders::{KnownFolder, describe_use};
use crate::layout::SIDEBAR_WIDTH;
use crate::shell::ModeId;

/// The switcher's element id, the same in every mode (only one mode draws at a time).
pub const SWITCHER_ID: &str = "location-switcher";

/// The menu's width: the switcher's, which is the full sidebar's inside its 8 px margins.
pub const MENU_WIDTH: f32 = SIDEBAR_WIDTH - 16.;

/// `ORIEL_LOCATIONS_MENU=1` opens the switcher's menu a moment after the window first draws,
/// for checking it in a real window, where scripted clicks are not allowed.
pub const OPEN_MENU_VARIABLE: &str = "ORIEL_LOCATIONS_MENU";

/// How long the check waits before it opens the menu.
const MENU_DELAY: Duration = Duration::from_secs(4);

type MenuBuilder = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

/// The switcher: a folder tile, the place's name and a caption under it, and the chevrons that
/// say it opens a menu. In the rail it is the tile alone, with the name as its tooltip.
#[derive(IntoElement)]
pub struct LocationSwitcher {
    name: SharedString,
    caption: Option<SharedString>,
    caption_is_path: bool,
    tooltip: Option<SharedString>,
    rail: bool,
    menu: MenuBuilder,
}

impl LocationSwitcher {
    /// A switcher showing `name`, whose menu `menu` fills when it opens, so it lists the places
    /// as they are then.
    pub fn new(
        name: impl Into<SharedString>,
        menu: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            caption: None,
            caption_is_path: false,
            tooltip: None,
            rail: false,
            menu: Rc::new(menu),
        }
    }

    /// The quieter line under the name, such as "248 files · 204 MB".
    pub fn caption(mut self, caption: impl Into<SharedString>) -> Self {
        self.caption = Some(caption.into());
        self
    }

    /// A caption that is a path, cut from the start when long so the nearest folders stay.
    pub fn path_caption(mut self, caption: impl Into<SharedString>) -> Self {
        self.caption = Some(caption.into());
        self.caption_is_path = true;
        self
    }

    /// The hover text, such as the folder's whole path.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    pub fn rail(mut self, rail: bool) -> Self {
        self.rail = rail;
        self
    }
}

/// The 32 px tile the folder icon sits on (36 px in the rail).
fn tile(size: f32, icon: f32, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    div()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .size(px(size))
        .rounded(theme.radius)
        .bg(theme.background)
        .border_1()
        .border_color(theme.border)
        .child(Icon::new(IconName::FolderOpen).size(px(icon)))
}

impl RenderOnce for LocationSwitcher {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let rail = self.rail;
        let tooltip = self
            .tooltip
            .clone()
            .or_else(|| rail.then(|| self.name.clone()));
        let trigger = Button::new(SWITCHER_ID)
            .ghost()
            .accessibility_label(self.name.clone())
            .when_some(tooltip, |button, tooltip| button.tooltip(tooltip))
            .map(|button| {
                if rail {
                    return button.w(px(48.)).h(px(48.)).child(tile(36., 18., cx));
                }
                let caption = self.caption.map(|caption| {
                    div()
                        .w_full()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .map(|this| {
                            if self.caption_is_path {
                                this.text_ellipsis_start()
                            } else {
                                this.text_ellipsis()
                            }
                        })
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(caption)
                });
                button.w_full().h(px(52.)).justify_start().child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .w_full()
                        .min_w_0()
                        .child(tile(32., 16., cx))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .flex_1()
                                .min_w_0()
                                .items_start()
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(self.name),
                                )
                                .children(caption),
                        )
                        .child(
                            Icon::new(IconName::ChevronsUpDown)
                                .size(px(14.))
                                .text_color(theme.muted_foreground),
                        ),
                )
            });
        let menu = self.menu;
        div()
            .relative()
            .w_full()
            .px_2()
            .when(rail, |this| this.flex().justify_center())
            .child(trigger.dropdown_menu(move |popup, window, cx| {
                menu(popup, window, cx)
                    .min_w(px(MENU_WIDTH))
                    .max_w(px(MENU_WIDTH))
                    .scrollable(true)
            }))
            .when(opens_at_start(), |this| {
                this.on_prepaint(|bounds, window, cx| {
                    // A moment after the window first draws, once the mode has listed its places.
                    window
                        .spawn(cx, async move |cx| {
                            cx.background_executor().timer(MENU_DELAY).await;
                            cx.update(|window, cx| press(bounds, window, cx)).ok();
                        })
                        .detach();
                })
            })
    }
}

/// Whether the check variable asks for the menu, the first time only.
fn opens_at_start() -> bool {
    static ASKED: OnceLock<bool> = OnceLock::new();
    static OPENED: AtomicBool = AtomicBool::new(false);
    *ASKED.get_or_init(|| std::env::var(OPEN_MENU_VARIABLE).is_ok_and(|value| value == "1"))
        && !OPENED.swap(true, Ordering::Relaxed)
}

/// A click in the middle of `bounds`, as the check's stand-in for the owner's.
fn press(bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let position = bounds.center();
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers: Modifiers::default(),
            click_count: 1,
        }),
        cx,
    );
}

/// The element id of the menu's row for `folder`: `location:<path>`.
pub fn location_id(folder: &Path) -> ElementId {
    ElementId::Name(format!("location:{}", folder.display()).into())
}

/// One row of the menu: the place's name, a status dot where the mode has one (Sync's
/// profiles), and at the end the icons of the modes that use its folder. VoiceOver reads the name,
/// then the status and which modes use it.
pub struct LocationItem {
    id: ElementId,
    name: SharedString,
    modes: Vec<ModeId>,
    status: Option<(Hsla, SharedString)>,
}

impl LocationItem {
    pub fn new(id: impl Into<ElementId>, name: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            modes: Vec::new(),
            status: None,
        }
    }

    /// The modes that use the place's folder.
    pub fn modes(mut self, modes: &[ModeId]) -> Self {
        self.modes = modes.to_vec();
        self
    }

    /// A dot in `color` before the name, with `status` in words for VoiceOver.
    pub fn status(mut self, color: Hsla, status: impl Into<SharedString>) -> Self {
        self.status = Some((color, status.into()));
        self
    }

    /// The row, for the caller to give its check mark and its click.
    pub fn into_item(self) -> PopupMenuItem {
        let Self {
            id,
            name,
            modes,
            status,
        } = self;
        let mut description = describe_use(&modes);
        if let Some((_, status)) = &status {
            description = format!("{status} · {description}");
        }
        let description = SharedString::from(description);
        PopupMenuItem::element(move |_, cx| {
            let muted = cx.theme().muted_foreground;
            div()
                .id(id.clone())
                .test_support()
                .aria_label(name.clone())
                .aria_description(description.clone())
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .flex_1()
                .min_w_0()
                .when_some(status.as_ref(), |this, (color, _)| {
                    this.child(div().size(px(8.)).flex_shrink_0().rounded_full().bg(*color))
                })
                .child(div().flex_1().min_w_0().truncate().child(name.clone()))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_shrink_0()
                        .items_center()
                        .gap_1()
                        .children(
                            modes
                                .iter()
                                .map(|mode| Icon::new(mode.icon()).size(px(12.)).text_color(muted)),
                        ),
                )
        })
    }
}

/// Adds the folders the other modes use and this one does not, under `title` ("Open one you
/// already use"), each with the modes that use it; `pick` gets the folder picked. Nothing is
/// added when there are none.
pub fn shared_locations(
    menu: PopupMenu,
    title: &str,
    folders: Vec<KnownFolder>,
    pick: impl Fn(&Path, &mut Window, &mut App) + 'static,
) -> PopupMenu {
    if folders.is_empty() {
        return menu;
    }
    let pick = Rc::new(pick);
    let mut menu = if menu.is_empty() {
        menu
    } else {
        menu.separator()
    };
    menu = menu.label(title.to_owned());
    for folder in folders {
        let pick = pick.clone();
        let path = folder.path().to_path_buf();
        menu = menu.item(
            LocationItem::new(location_id(&path), folder.name())
                .modes(folder.modes())
                .into_item()
                .on_click(move |_, window, cx| pick(&path, window, cx)),
        );
    }
    menu
}
