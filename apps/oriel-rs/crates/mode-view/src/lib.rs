//! View: the gallery of a folder, the viewer, the capsule player and the comic reader. Phase 0
//! of plan 063 builds the gallery, the viewer and the player as spikes, to measure them.
//!
//! View reads; it never writes inside a folder it shows. What it keeps (the thumbnails) goes
//! under `DataRoot::view()`.

pub mod gallery;
pub mod listing;
mod player;
mod spike;
pub mod thumbnails;
pub mod viewer;

pub use gallery::{Gallery, GalleryEvent, Listing};
pub use player::CapsulePlayer;
pub use viewer::{Viewer, ViewerEvent};

use std::path::PathBuf;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable as _, Global,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, Render, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _,
    Window, div,
};
use oriel_core_paths::DataRoot;
use oriel_ui::{ModeLayout, ShellState, TopBar};

/// A folder to open at start, for runs without the picker (Phase 0's measurements).
pub const OPEN_VARIABLE: &str = "ORIEL_RS_OPEN";

/// Marks View's keys as bound, so a second window does not bind them twice.
struct ViewKeys;

impl Global for ViewKeys {}

/// Binds View's keys. `ViewMode::new` calls it, so the app shell need not.
pub fn init(cx: &mut App) {
    if cx.has_global::<ViewKeys>() {
        return;
    }
    cx.set_global(ViewKeys);
    viewer::bind_keys(cx);
}

pub struct ViewMode {
    shell: Entity<ShellState>,
    gallery: Entity<Gallery>,
    viewer: Option<Entity<Viewer>>,
    /// The open viewer's close event, dropped with it.
    viewer_subscription: Option<Subscription>,
    /// Where focus was before the viewer took it, to give it back on close.
    focus_before_viewer: Option<FocusHandle>,
    pub(crate) spike: Option<spike::Spike>,
    _subscriptions: Vec<Subscription>,
}

impl ViewMode {
    /// View for the shell, keeping its thumbnails in this run's data folder. Opens the folder
    /// [`OPEN_VARIABLE`] names, if it names one.
    pub fn new(shell: &Entity<ShellState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let data = DataRoot::from_environment().expect("Oriel RS needs a data folder");
        let mut view = Self::with_data(shell, &data, window, cx);
        view.spike = spike::Spike::from_environment(window, cx);
        if let Some(folder) = std::env::var_os(OPEN_VARIABLE).filter(|value| !value.is_empty()) {
            view.open_folder(PathBuf::from(folder), cx);
        }
        view
    }

    /// View keeping its thumbnails under `data`, with nothing open.
    pub fn with_data(
        shell: &Entity<ShellState>,
        data: &DataRoot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init(cx);
        let thumbnails = data.view().join("thumbnails");
        let gallery = cx.new(|cx| Gallery::new(shell, thumbnails, cx));
        let subscriptions = vec![
            cx.observe(shell, |_, _, cx| cx.notify()),
            cx.observe(&gallery, |_, _, cx| cx.notify()),
            cx.subscribe_in(&gallery, window, Self::on_gallery_event),
        ];
        Self {
            shell: shell.clone(),
            gallery,
            viewer: None,
            viewer_subscription: None,
            focus_before_viewer: None,
            spike: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn gallery(&self) -> &Entity<Gallery> {
        &self.gallery
    }

    pub fn viewer(&self) -> Option<&Entity<Viewer>> {
        self.viewer.as_ref()
    }

    pub fn open_folder(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        self.gallery
            .update(cx, |gallery, cx| gallery.open(folder, cx));
    }

    /// Asks for a folder with the system's picker, and opens it.
    fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let chosen = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = chosen.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| this.open_folder(folder, cx))
                .ok();
        })
        .detach();
    }

    /// Opens the viewer on item `ix` of the gallery's listing.
    pub fn open_viewer(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.gallery.read(cx).entries().clone();
        self.open_viewer_with(entries, ix, window, cx);
    }

    /// Opens the viewer on item `ix` of `entries`, which stepping walks through.
    pub(crate) fn open_viewer_with(
        &mut self,
        entries: std::sync::Arc<[listing::MediaEntry]>,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ix >= entries.len() {
            return;
        }
        let viewer = cx.new(|cx| Viewer::new(entries, ix, window, cx));
        let closed = cx.subscribe_in(&viewer, window, |this, _, event, window, cx| {
            let ViewerEvent::Closed(ix) = event;
            this.close_viewer(*ix, window, cx);
        });
        self.viewer_subscription = Some(closed);
        if self.focus_before_viewer.is_none() {
            self.focus_before_viewer = window.focused(cx);
        }
        viewer.focus_handle(cx).focus(window, cx);
        self.viewer = Some(viewer);
        cx.notify();
    }

    fn close_viewer(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.close_viewer_now(window, cx);
        self.gallery
            .update(cx, |gallery, cx| gallery.reveal(ix, cx));
    }

    /// Closes the viewer without moving the gallery.
    pub(crate) fn close_viewer_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.viewer = None;
        self.viewer_subscription = None;
        if let Some(focus) = self.focus_before_viewer.take() {
            focus.focus(window, cx);
        }
        cx.notify();
    }

    fn on_gallery_event(
        &mut self,
        _: &Entity<Gallery>,
        event: &GalleryEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            GalleryEvent::Activated(ix) => self.open_viewer(*ix, window, cx),
            GalleryEvent::Listed => {}
        }
    }

    fn render_count(&self, cx: &App) -> Option<impl IntoElement> {
        let gallery = self.gallery.read(cx);
        if *gallery.listing() != Listing::Listed {
            return None;
        }
        let count = gallery.entries().len();
        let label = SharedString::from(if count == 1 {
            "1 item".to_string()
        } else {
            format!("{count} items")
        });
        Some(
            div()
                .id("gallery-count")
                .role(Role::Status)
                .test_support()
                .aria_label(label.clone())
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child(label),
        )
    }
}

impl Render for ViewMode {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(spike) = &mut self.spike {
            spike.on_frame(&self.gallery, self.viewer.as_ref(), window, cx);
        }
        if let Some(viewer) = &self.viewer {
            return viewer.clone().into_any_element();
        }

        let title = self
            .gallery
            .read(cx)
            .folder()
            .map(gallery::display_name)
            .unwrap_or_else(|| "View".to_string());
        let mut top_bar = TopBar::new(&self.shell, title);
        if let Some(count) = self.render_count(cx) {
            top_bar = top_bar.trailing(count);
        }
        let top_bar = top_bar.trailing(
            Button::new("open-folder")
                .ghost()
                .small()
                .icon(Icon::new(IconName::FolderOpen))
                .label("Open")
                .tooltip("Open a folder")
                .on_click(cx.listener(|this, _, _, cx| this.choose_folder(cx))),
        );

        ModeLayout::new(&self.shell)
            .child(top_bar)
            .child(self.gallery.clone())
            .into_any_element()
    }
}
