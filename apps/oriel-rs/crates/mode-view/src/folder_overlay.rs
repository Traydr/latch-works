//! Folders: the folder browser over the gallery (`FolderGridOverlay.tsx`). It shows the opened
//! folder's children as cards; a click browses into one, a double-click opens it, and on the
//! opened folder itself each child has Included or Excluded, which a recursive scan follows.
//! Escape, Close or a click on the scrim closes it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _,
    button::{Button, ButtonVariants as _},
};
use gpui_kit::{
    App, AppContext as _, ClickEvent, Context, ElementId, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, MouseButton, ParentElement as _, Render,
    Role, SharedString, StatefulInteractiveElement as _, Styled as _, Task, TestSupportExt as _,
    Window, actions, div, prelude::FluentBuilder as _, px,
};
use oriel_core_domain::FolderNode;
use oriel_core_index::list_folder_children;

use crate::gallery::display_name;

actions!(
    folder_overlay,
    [
        /// Closes the folder browser (Escape).
        CloseFolderBrowser
    ]
);

const KEY_CONTEXT: &str = "FolderBrowser";

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new(
        "escape",
        CloseFolderBrowser,
        Some(KEY_CONTEXT),
    )]);
}

#[derive(Clone, Debug, PartialEq)]
pub enum FolderOverlayEvent {
    Close,
    /// Open and scan this folder.
    Open(PathBuf),
    /// Exclude or include this child of the opened folder.
    ToggleExcluded(PathBuf),
}

/// The id of a folder's card, for tests: `folder-card:<path>`.
pub fn card_id(path: &str) -> ElementId {
    ElementId::Name(format!("folder-card:{path}").into())
}

/// The id of a child's Included or Excluded button: `exclude:<path>`.
pub fn exclude_id(path: &str) -> ElementId {
    ElementId::Name(format!("exclude:{path}").into())
}

pub struct FolderOverlay {
    root: Arc<Path>,
    current: PathBuf,
    breadcrumbs: Vec<(PathBuf, SharedString)>,
    folders: Vec<FolderNode>,
    loading: bool,
    excluded: Vec<String>,
    focus: FocusHandle,
    _load: Option<Task<()>>,
}

impl EventEmitter<FolderOverlayEvent> for FolderOverlay {}

impl Focusable for FolderOverlay {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl FolderOverlay {
    pub fn new(
        root: Arc<Path>,
        excluded: Vec<String>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut overlay = Self {
            current: root.to_path_buf(),
            breadcrumbs: vec![(root.to_path_buf(), display_name(&root).into())],
            root,
            folders: Vec::new(),
            loading: false,
            excluded,
            focus: cx.focus_handle(),
            _load: None,
        };
        let root = overlay.root.to_path_buf();
        overlay.load(root, cx);
        overlay
    }

    pub fn current(&self) -> &Path {
        &self.current
    }

    pub fn folders(&self) -> &[FolderNode] {
        &self.folders
    }

    pub fn is_loading(&self) -> bool {
        self.loading
    }

    /// The opened folder's excluded children, after a toggle was saved.
    pub fn set_excluded(&mut self, excluded: Vec<String>, cx: &mut Context<Self>) {
        self.excluded = excluded;
        cx.notify();
    }

    fn load(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        self.loading = true;
        let read = folder.clone();
        self._load = Some(cx.spawn(async move |this, cx| {
            let folders = cx
                .background_spawn(async move { list_folder_children(&read).unwrap_or_default() })
                .await;
            this.update(cx, |this, cx| {
                if this.current == folder {
                    this.folders = folders;
                    this.loading = false;
                    cx.notify();
                }
            })
            .ok();
        }));
        cx.notify();
    }

    /// Browses into `folder`, or back to a breadcrumb.
    fn browse(&mut self, folder: PathBuf, name: SharedString, cx: &mut Context<Self>) {
        match self
            .breadcrumbs
            .iter()
            .position(|(path, _)| *path == folder)
        {
            Some(at) => self.breadcrumbs.truncate(at + 1),
            None => self.breadcrumbs.push((folder.clone(), name)),
        }
        self.current = folder.clone();
        self.load(folder, cx);
    }

    fn back(&mut self, cx: &mut Context<Self>) {
        if self.breadcrumbs.len() <= 1 {
            return;
        }
        let (path, name) = self.breadcrumbs[self.breadcrumbs.len() - 2].clone();
        self.browse(path, name, cx);
    }

    fn render_card(&self, folder: &FolderNode, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let theme = cx.theme();
        let path = PathBuf::from(&folder.path);
        let name: SharedString = folder.name.clone().into();
        let showing_root = self.current == self.root.as_ref();
        let excluded = showing_root && self.excluded.contains(&folder.path);
        let browse_path = path.clone();
        let browse_name = name.clone();
        let toggle_path = path.clone();

        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded(theme.radius_lg)
            .bg(theme.background)
            .border_1()
            .border_color(theme.border)
            .when(excluded, |this| this.opacity(0.7))
            .child(
                div()
                    .id(card_id(&folder.path))
                    .role(Role::Button)
                    .test_support()
                    .aria_label(name.clone())
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_2()
                    .min_h(px(74.))
                    .child(
                        Icon::new(IconName::Folder)
                            .size(px(32.))
                            .text_color(if excluded {
                                theme.muted_foreground
                            } else {
                                gpui_kit::rgb(0xf59e0b).into()
                            }),
                    )
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .text_center()
                            .text_size(px(13.))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .child(name.clone()),
                    )
                    .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                        if event.click_count() >= 2 {
                            cx.emit(FolderOverlayEvent::Open(browse_path.clone()));
                        } else {
                            this.browse(browse_path.clone(), browse_name.clone(), cx);
                        }
                    })),
            )
            .when(showing_root, |this| {
                this.child({
                    let button = Button::new(exclude_id(&folder.path))
                        .small()
                        .w_full()
                        .label(if excluded { "Excluded" } else { "Included" })
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(FolderOverlayEvent::ToggleExcluded(toggle_path.clone()));
                        }));
                    if excluded {
                        button.danger()
                    } else {
                        button.outline()
                    }
                })
            })
    }
}

impl Render for FolderOverlay {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let cards: Vec<_> = self
            .folders
            .clone()
            .iter()
            .map(|folder| self.render_card(folder, cx).into_any_element())
            .collect();
        let theme = cx.theme();
        let current = self.current.clone();
        let crumbs = self
            .breadcrumbs
            .clone()
            .into_iter()
            .enumerate()
            .map(|(ix, (path, name))| {
                let last = ix + 1 == self.breadcrumbs.len();
                let target = path.clone();
                let label = name.clone();
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_1()
                    .when(ix > 0, |this| {
                        this.child(div().text_color(theme.muted_foreground).child("/"))
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("crumb:{}", path.display())))
                            .role(Role::Button)
                            .test_support()
                            .aria_label(format!("Browse {name}"))
                            .truncate()
                            .when(last, |this| this.font_weight(gpui_kit::FontWeight::MEDIUM))
                            .when(!last, |this| this.text_color(theme.muted_foreground))
                            .child(name)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.browse(target.clone(), label.clone(), cx);
                            })),
                    )
            })
            .collect::<Vec<_>>();

        let body = if self.loading {
            div()
                .py_12()
                .flex()
                .justify_center()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child("Loading…")
                .into_any_element()
        } else if cards.is_empty() {
            let open = current.clone();
            div()
                .py_12()
                .flex()
                .flex_col()
                .items_center()
                .gap_3()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child("No subfolders")
                .child(
                    Button::new("open-this-folder")
                        .outline()
                        .label("Open this folder")
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(FolderOverlayEvent::Open(open.clone()));
                        })),
                )
                .into_any_element()
        } else {
            div()
                .grid()
                .grid_cols(4)
                .gap_3()
                .children(cards)
                .into_any_element()
        };

        let open = current.clone();
        div()
            .id("folder-browser")
            .role(Role::Dialog)
            .test_support()
            .aria_label("Folder browser")
            // The gallery underneath takes no presses or scrolls while the browser is open.
            .occlude()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &CloseFolderBrowser, _, cx| {
                cx.emit(FolderOverlayEvent::Close);
            }))
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .id("close-folder-browser")
                    .role(Role::Button)
                    .test_support()
                    .aria_label("Close folder browser")
                    .absolute()
                    .inset_0()
                    .bg(gpui_kit::black().opacity(0.35))
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(FolderOverlayEvent::Close))),
            )
            .child(
                div()
                    .id("folder-browser-panel")
                    .flex()
                    .flex_col()
                    .mx_6()
                    .w_full()
                    .max_w(px(768.))
                    .max_h(gpui_kit::relative(0.72))
                    .overflow_hidden()
                    .rounded(theme.radius_lg)
                    .bg(theme.popover)
                    .border_1()
                    .border_color(theme.border)
                    .shadow_2xl()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .py(px(10.))
                            .pl_5()
                            .pr(px(10.))
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                Icon::new(IconName::Folder)
                                    .size(px(20.))
                                    .text_color(gpui_kit::rgb(0xf59e0b)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .flex_1()
                                    .min_w_0()
                                    .items_center()
                                    .gap_1()
                                    .text_size(px(13.))
                                    .children(crumbs),
                            )
                            .child(
                                Button::new("folder-browser-back")
                                    .ghost()
                                    .icon(Icon::new(IconName::ChevronLeft))
                                    .label("Back")
                                    .tooltip("Back to the parent folder")
                                    .disabled(self.breadcrumbs.len() <= 1)
                                    .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
                            )
                            .child(
                                Button::new("folder-browser-open")
                                    .outline()
                                    .icon(Icon::new(IconName::FolderOpen))
                                    .label("Open")
                                    .tooltip("Open and scan this folder")
                                    .on_click(cx.listener(move |_, _, _, cx| {
                                        cx.emit(FolderOverlayEvent::Open(open.clone()));
                                    })),
                            )
                            .child(
                                Button::new("folder-browser-close")
                                    .ghost()
                                    .icon(Icon::new(IconName::Close))
                                    .tooltip("Close")
                                    .accessibility_label("Close")
                                    .on_click(cx.listener(|_, _, _, cx| {
                                        cx.emit(FolderOverlayEvent::Close);
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("folder-browser-grid")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p_4()
                            .child(body),
                    )
                    .child(
                        div()
                            .px_5()
                            .py(px(10.))
                            .border_t_1()
                            .border_color(theme.border)
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Click to browse into folder · Double-click to open and scan"),
                    ),
            )
    }
}
