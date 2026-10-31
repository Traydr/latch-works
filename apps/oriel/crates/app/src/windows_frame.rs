//! The window's top on Windows. The window draws its own title bar there as on macOS
//! (`appears_transparent`), so its first row is GPUI Kit's [`TitleBar`]: the app's menus, which
//! macOS shows in the menu bar and Windows has nowhere else to put, and the caption buttons,
//! which Windows hit-tests itself (snap layouts included). The shell fills the rest.

use gpui_kit::component::menu::AppMenuBar;
use gpui_kit::component::{GlobalState, TitleBar};
use gpui_kit::{
    App, Context, Entity, Global, IntoElement, ParentElement as _, Render, Styled as _, Window, div,
};

use crate::shell::Shell;

/// The menu bar in the window, which [`reload_menus`] keeps in step with the mode.
struct MenuBar(Entity<AppMenuBar>);

impl Global for MenuBar {}

pub struct WindowsFrame {
    menu_bar: Entity<AppMenuBar>,
    shell: Entity<Shell>,
}

impl WindowsFrame {
    pub fn new(shell: Entity<Shell>, cx: &mut Context<Self>) -> Self {
        let menus = cx.get_menus().unwrap_or_default();
        GlobalState::global_mut(cx).set_app_menus(menus);
        let menu_bar = AppMenuBar::new(cx);
        cx.set_global(MenuBar(menu_bar.clone()));
        Self { menu_bar, shell }
    }
}

/// Hands the menus `cx.set_menus` was last given to the menu bar in the window.
pub fn reload_menus(cx: &mut App) {
    let menus = cx.get_menus().unwrap_or_default();
    GlobalState::global_mut(cx).set_app_menus(menus);
    if let Some(MenuBar(bar)) = cx.try_global::<MenuBar>() {
        bar.clone().update(cx, |bar, cx| bar.reload(cx));
    }
}

impl Render for WindowsFrame {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(TitleBar::new().child(self.menu_bar.clone()))
            .child(div().flex_1().min_h_0().child(self.shell.clone()))
    }
}
