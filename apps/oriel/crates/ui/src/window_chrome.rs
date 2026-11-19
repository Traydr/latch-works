//! The window's own chrome off macOS, where no system title bar or menu bar is drawn: the
//! caption buttons (minimize, maximize or restore, close) at the window's top right, and the app's
//! menus in a row across the window's top that Alt shows. On macOS the system draws the window
//! buttons over the sidebar's strip and the menus in the menu bar, so neither part draws there.
//!
//! On Windows the caption buttons draw nothing but their look: each is a window control area,
//! which Windows hit-tests itself, so it presses them, shows Snap Layouts over maximize, and
//! closes the window as its own buttons would. They must not sit inside a [`DragStrip`]: GPUI
//! answers a hit test with the first control area under the pointer in paint order, which would be
//! the strip's.
//!
//! [`DragStrip`]: crate::drag::DragStrip

use gpui_kit::assets::IconName;
use gpui_kit::component::menu::PopupMenu;
use gpui_kit::component::{ActiveTheme as _, Icon, Sizable as _};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, DismissEvent, Entity, FocusHandle, Focusable as _,
    Hsla, InteractiveElement as _, IntoElement, KeyDownEvent, Modifiers, MouseButton, OwnedMenu,
    OwnedMenuItem, ParentElement as _, Render, RenderOnce, Role, StatefulInteractiveElement as _,
    Styled, Subscription, TestSupportExt as _, Window, WindowControlArea, anchored, deferred, div,
    prelude::FluentBuilder as _, px,
};

use crate::controls::TextRole as _;

/// Whether the window draws its own caption buttons and menus: everywhere but macOS.
const DRAWS_OWN_CHROME: bool = !cfg!(target_os = "macos");

/// A caption button's width, Windows' own.
const CAPTION_BUTTON_WIDTH: f32 = 46.;

/// The width the caption buttons take at most.
const CAPTION_BUTTONS_WIDTH: f32 = 3. * CAPTION_BUTTON_WIDTH;

/// The window's minimize, maximize or restore, and close buttons, the full height of the bar they
/// end. A full-screen window has none, as Windows hit-tests no control area then.
#[derive(IntoElement)]
pub struct CaptionButtons {
    on_dark_stage: bool,
}

impl CaptionButtons {
    /// The buttons, or none on macOS, where the system draws its own.
    pub fn for_window() -> Option<Self> {
        DRAWS_OWN_CHROME.then_some(Self {
            on_dark_stage: false,
        })
    }

    /// The buttons over the viewer's or the reader's black stage, in its top right corner, white
    /// whatever the theme; none on macOS. They show and fade with the stage's own controls.
    pub fn over_stage() -> Option<impl IntoElement> {
        DRAWS_OWN_CHROME.then(|| {
            div()
                .absolute()
                .top_0()
                .right_0()
                .h(px(STAGE_CAPTION_HEIGHT))
                .child(Self {
                    on_dark_stage: true,
                })
        })
    }

    /// The room a stage's top row keeps clear at its end for [`Self::over_stage`].
    pub fn stage_room(window: &Window) -> f32 {
        if DRAWS_OWN_CHROME && !window.is_fullscreen() {
            CAPTION_BUTTONS_WIDTH
        } else {
            0.
        }
    }
}

/// The caption buttons' height over a stage, which has no bar for them to fill.
const STAGE_CAPTION_HEIGHT: f32 = 40.;

impl RenderOnce for CaptionButtons {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // Under a window manager's own decorations its title bar already has these buttons.
        let decorated_by_system = cfg!(target_os = "linux")
            && !matches!(
                window.window_decorations(),
                gpui_kit::Decorations::Client { .. }
            );
        if window.is_fullscreen() || decorated_by_system {
            return div().into_any_element();
        }

        let supported = window.window_controls();
        let maximized = window.is_maximized();
        let look = CaptionLook::new(self.on_dark_stage, cx);

        div()
            .id("caption-buttons")
            .test_support()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .h_full()
            .when(supported.minimize, |this| {
                this.child(CaptionButton::new(Caption::Minimize, look))
            })
            .when(supported.maximize, |this| {
                this.child(CaptionButton::new(
                    if maximized {
                        Caption::Restore
                    } else {
                        Caption::Maximize
                    },
                    look,
                ))
            })
            .child(CaptionButton::new(Caption::Close, look))
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum Caption {
    Minimize,
    Maximize,
    Restore,
    Close,
}

impl Caption {
    fn id(self) -> &'static str {
        match self {
            Self::Minimize => "caption-minimize",
            Self::Maximize => "caption-maximize",
            Self::Restore => "caption-restore",
            Self::Close => "caption-close",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Minimize => "Minimize",
            Self::Maximize => "Maximize",
            Self::Restore => "Restore",
            Self::Close => "Close",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Minimize => IconName::WindowMinimize,
            Self::Maximize => IconName::WindowMaximize,
            Self::Restore => IconName::WindowRestore,
            Self::Close => IconName::WindowClose,
        }
    }

    fn area(self) -> WindowControlArea {
        match self {
            Self::Minimize => WindowControlArea::Min,
            Self::Maximize | Self::Restore => WindowControlArea::Max,
            Self::Close => WindowControlArea::Close,
        }
    }
}

/// The buttons' colours: GPUI Kit's title bar's, with close turning to the danger colour, as
/// Windows' own does; on the dark stage, white over a lighter veil.
#[derive(Clone, Copy)]
struct CaptionLook {
    foreground: Hsla,
    hover: (Hsla, Hsla),
    active: Hsla,
    close_hover: (Hsla, Hsla),
    close_active: Hsla,
}

impl CaptionLook {
    fn new(on_dark_stage: bool, cx: &App) -> Self {
        let theme = cx.theme();
        let close_hover = (theme.danger, theme.danger_foreground);
        if on_dark_stage {
            let white = gpui_kit::white();
            Self {
                foreground: white,
                hover: (white.opacity(0.14), white),
                active: white.opacity(0.22),
                close_hover,
                close_active: theme.danger_active,
            }
        } else {
            Self {
                foreground: theme.foreground,
                hover: (theme.secondary_hover, theme.secondary_foreground),
                active: theme.secondary_active,
                close_hover,
                close_active: theme.danger_active,
            }
        }
    }
}

#[derive(IntoElement)]
struct CaptionButton {
    caption: Caption,
    look: CaptionLook,
}

impl CaptionButton {
    fn new(caption: Caption, look: CaptionLook) -> Self {
        Self { caption, look }
    }
}

impl RenderOnce for CaptionButton {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let caption = self.caption;
        let look = self.look;
        let ((hover_bg, hover_fg), active_bg) = match caption {
            Caption::Close => (look.close_hover, look.close_active),
            _ => (look.hover, look.active),
        };

        div()
            .id(caption.id())
            .test_support()
            .role(Role::Button)
            .aria_label(caption.label())
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .w(px(CAPTION_BUTTON_WIDTH))
            .h_full()
            .text_color(look.foreground)
            .hover(|style| style.bg(hover_bg).text_color(hover_fg))
            .active(|style| style.bg(active_bg).text_color(hover_fg))
            // Windows presses these itself, from the hit test.
            .when(cfg!(target_os = "windows"), |this| {
                this.window_control_area(caption.area())
            })
            .when(cfg!(target_os = "linux"), |this| {
                this.on_mouse_down(MouseButton::Left, |_, window, cx| {
                    window.prevent_default();
                    cx.stop_propagation();
                })
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    match caption {
                        Caption::Minimize => window.minimize_window(),
                        Caption::Maximize | Caption::Restore => window.zoom_window(),
                        Caption::Close => window.remove_window(),
                    }
                })
            })
            .child(Icon::new(caption.icon()).small())
    }
}

/// The app's menus off macOS, File to Help, in a row across the window's top that is hidden
/// until Alt shows it, as Windows apps with a hidden menu bar do: Alt pressed and let go on its
/// own shows the row with File in focus, ← → move along it, ↓, Return or Space open a menu, and a
/// mouse press opens one too. It goes again with Escape, a second Alt, a command chosen, or a press
/// anywhere else. Its commands act on what had focus before Alt, and it reads the menus as they
/// are when it shows (`cx.get_menus()`), so it follows the mode on screen.
pub struct MenuBar {
    shown: bool,
    /// Alt went down with nothing pressed since: letting it go shows or hides the row.
    alt_alone: bool,
    menus: Vec<OwnedMenu>,
    /// The menu the row's ring rests on, and the one whose popup is open.
    current: usize,
    open: Option<(usize, Entity<PopupMenu>, Subscription)>,
    focus: FocusHandle,
    /// What had focus before the row showed: the commands act on it, and it gets focus back.
    return_focus: Option<FocusHandle>,
}

/// The row's height.
const MENU_BAR_HEIGHT: f32 = 32.;

impl MenuBar {
    /// The menu bar, or none on macOS, where the menus are in the system's menu bar.
    pub fn for_window(cx: &mut App) -> Option<Entity<Self>> {
        DRAWS_OWN_CHROME.then(|| {
            cx.new(|cx| Self {
                shown: false,
                alt_alone: false,
                menus: Vec::new(),
                current: 0,
                open: None,
                focus: cx.focus_handle(),
                return_focus: None,
            })
        })
    }

    pub fn is_shown(&self) -> bool {
        self.shown
    }

    /// Follows the modifiers as the window's root sees them change: Alt let go on its own shows
    /// or hides the row.
    pub fn on_modifiers_changed(
        &mut self,
        modifiers: &Modifiers,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let alt_only = modifiers.alt
            && !modifiers.control
            && !modifiers.shift
            && !modifiers.platform
            && !modifiers.function;
        if alt_only {
            self.alt_alone = true;
        } else if self.alt_alone && !modifiers.modified() {
            self.alt_alone = false;
            if self.shown {
                self.hide(window, cx);
            } else {
                self.show(window, cx);
            }
        } else {
            self.alt_alone = false;
        }
    }

    /// A key or a press while Alt is down makes it a shortcut's Alt, not the menu bar's.
    pub fn interrupt(&mut self) {
        self.alt_alone = false;
    }

    fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menus = cx.get_menus().unwrap_or_default();
        if self.menus.is_empty() {
            return;
        }
        self.return_focus = window.focused(cx);
        self.shown = true;
        self.current = 0;
        self.focus.focus(window, cx);
        cx.notify();
    }

    fn hide(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.shown {
            return;
        }
        self.shown = false;
        self.open = None;
        if let Some(focus) = self.return_focus.take() {
            focus.focus(window, cx);
        }
        cx.notify();
    }

    fn open_menu(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menus.get(index).cloned() else {
            return;
        };
        let context = self.return_focus.clone();
        let items = menu.items;
        let popup = PopupMenu::build(window, cx, move |menu, window, cx| {
            let menu = match context.clone() {
                Some(focus) => menu.action_context(focus),
                None => menu,
            };
            with_items(menu, items.clone(), window, cx)
        });
        // A command chosen, Escape or a press elsewhere closes the popup, and the row with it.
        let dismissed = cx.subscribe_in(&popup, window, |this, _, _: &DismissEvent, window, cx| {
            this.hide(window, cx)
        });
        popup.read(cx).focus_handle(cx).focus(window, cx);
        self.current = index;
        self.open = Some((index, popup, dismissed));
        cx.notify();
    }

    fn toggle_menu(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .open
            .as_ref()
            .is_some_and(|(open, _, _)| *open == index)
        {
            self.hide(window, cx);
        } else {
            self.open_menu(index, window, cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.menus.len();
        if count == 0 {
            return;
        }
        match event.keystroke.key.as_str() {
            "left" => self.current = (self.current + count - 1) % count,
            "right" => self.current = (self.current + 1) % count,
            "down" | "enter" | "space" => {
                self.open_menu(self.current, window, cx);
            }
            "escape" => self.hide(window, cx),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

impl Render for MenuBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.shown {
            return div().id("menu-bar").into_any_element();
        }
        let theme = cx.theme();
        let (ring, open_bg) = (theme.ring, theme.accent);
        let row_focused = self.focus.is_focused(window);
        let open = self
            .open
            .as_ref()
            .map(|(index, popup, _)| (*index, popup.clone()));
        let items: Vec<AnyElement> = self
            .menus
            .iter()
            .enumerate()
            .map(|(index, menu)| {
                let is_open = open.as_ref().is_some_and(|(open, _)| *open == index);
                let current = index == self.current;
                div()
                    .id(("menu-bar-item", index))
                    .test_support()
                    .role(Role::MenuItem)
                    .aria_label(menu.name.clone())
                    .relative()
                    .flex()
                    .items_center()
                    .h(px(MENU_BAR_HEIGHT - 6.))
                    .px_2p5()
                    .rounded(theme.radius)
                    .text_body()
                    .cursor_pointer()
                    .hover(|style| style.bg(open_bg))
                    .when(is_open, |this| this.bg(open_bg))
                    .when(current && row_focused && !is_open, |this| {
                        this.border_1().border_color(ring)
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            window.prevent_default();
                            cx.stop_propagation();
                            this.toggle_menu(index, window, cx);
                        }),
                    )
                    // With one menu open, the pointer opens the menu it moves onto.
                    .on_hover(cx.listener(move |this, hovered: &bool, window, cx| {
                        let other_open = this
                            .open
                            .as_ref()
                            .is_some_and(|(open, _, _)| *open != index);
                        if *hovered && other_open {
                            this.open_menu(index, window, cx);
                        }
                    }))
                    .child(menu.name.clone())
                    .when_some(open.clone().filter(|_| is_open), |this, (_, popup)| {
                        this.child(deferred(
                            anchored()
                                .anchor(gpui_kit::Anchor::TopLeft)
                                .snap_to_window_with_margin(px(8.))
                                .child(div().occlude().mt(px(MENU_BAR_HEIGHT - 6.)).child(popup)),
                        ))
                    })
                    .into_any_element()
            })
            .collect();
        div()
            .id("menu-bar")
            .test_support()
            .role(Role::MenuBar)
            .aria_label("Menu bar")
            .track_focus(&self.focus)
            .key_context("OrielMenuBar")
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                if this.open.is_none() {
                    this.hide(window, cx);
                }
            }))
            .flex()
            .flex_row()
            .items_center()
            .flex_shrink_0()
            .gap_0p5()
            .w_full()
            .h(px(MENU_BAR_HEIGHT))
            .px_2()
            .bg(theme.sidebar)
            .text_color(theme.sidebar_foreground)
            .border_b_1()
            .border_color(theme.sidebar_border)
            .children(items)
            .into_any_element()
    }
}

/// `items` in `menu`, as GPUI Kit's menu bar draws an app menu's: the actions with their shortcuts
/// and check marks, the separators, and the submenus.
fn with_items(
    menu: PopupMenu,
    items: Vec<OwnedMenuItem>,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    items.into_iter().fold(menu, |menu, item| match item {
        OwnedMenuItem::Action {
            name,
            action,
            checked,
            disabled,
            ..
        } => menu.menu_with_check_and_disabled(name, checked, action, disabled),
        OwnedMenuItem::Separator => menu.separator(),
        OwnedMenuItem::Submenu(submenu) => {
            let items = submenu.items;
            menu.submenu(submenu.name, window, cx, move |menu, window, cx| {
                with_items(menu, items.clone(), window, cx)
            })
        }
        OwnedMenuItem::SystemMenu(_) => menu,
    })
}
