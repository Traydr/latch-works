//! Tidy's own folder picker (`components/FolderPicker.tsx`), in place of the system's: a path
//! field that lists the folders inside what is typed and narrows them as a name is typed, with
//! the places beside it. ↑ ↓ highlight a folder, ↩ opens it, ↩ on nothing highlighted (or ⌘↩)
//! chooses, ⌘↑ goes to the enclosing folder.
//!
//! A picker for a folder to tidy lists Electron Oriel's places (the home folder, its usual
//! folders, the drives) and chooses any folder, as Electron's does. In a sandboxed run
//! (`ORIEL_RS_DATA_DIR` set), where Tidy changes files only inside its sandbox or the temp folder,
//! it offers those two first, lists the rest as unavailable, with the rule as their caption and in
//! each one's tooltip, and cannot choose a folder outside them. A picker `within` a root (Move
//! to…, a preferred folder) stays inside that root.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, WindowExt as _};
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, px,
};
use oriel_core_domain::{NamedPath, compare_by_name, is_system_junk_directory};
use oriel_core_paths::DataRoot;
use oriel_ui::ControlSize as _;

/// What a picker is for.
pub struct PickOptions {
    pub title: SharedString,
    /// The primary button's verb, such as "Choose" or "Move here".
    pub action: SharedString,
    /// The folder it opens on; the first place (or `within`) when absent.
    pub start: Option<PathBuf>,
    /// A folder to highlight once the start folder is listed, such as the current root.
    pub select: Option<PathBuf>,
    /// Keeps the picker inside this folder, which the path field names by the second value.
    pub within: Option<(PathBuf, String)>,
    /// The sandbox a folder to tidy must lie in, in a sandboxed run (`ORIEL_RS_DATA_DIR` set);
    /// `None` in the owner's run, which takes any folder.
    pub sandbox: Option<DataRoot>,
}

type OnChoose = Rc<dyn Fn(PathBuf, &mut Window, &mut App)>;

/// One folder inside the one listed.
#[derive(Clone, Debug, PartialEq)]
pub struct FolderEntry {
    pub name: String,
    pub path: PathBuf,
}

impl NamedPath for FolderEntry {
    fn name(&self) -> &str {
        &self.name
    }

    fn path(&self) -> &str {
        self.path.to_str().unwrap_or_default()
    }
}

/// A folder's listing, or why there is none (`FolderListing`).
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub path: PathBuf,
    pub parent: Option<PathBuf>,
    pub folders: Result<Vec<FolderEntry>, String>,
}

/// Hidden folders, system folders and app bundles are never offered (`offered`).
fn offered(name: &str) -> bool {
    !name.starts_with('.') && !is_system_junk_directory(name) && !name.ends_with(".app")
}

/// The folders inside `folder`, in natural order; a symlink to a folder counts (`listFolder`).
pub fn list_folder(folder: &Path) -> Listing {
    let parent = folder.parent().map(Path::to_path_buf);
    let folders = match std::fs::read_dir(folder) {
        Ok(entries) => {
            let mut folders: Vec<FolderEntry> = entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let path = entry.path();
                    (offered(&name) && path.is_dir()).then_some(FolderEntry { name, path })
                })
                .collect();
            folders.sort_by(compare_by_name);
            Ok(folders)
        }
        Err(error) => Err(match error.kind() {
            std::io::ErrorKind::NotFound => "There is no folder here.".into(),
            std::io::ErrorKind::NotADirectory => "This is a file, not a folder.".into(),
            std::io::ErrorKind::PermissionDenied => {
                "Tidy is not allowed to read this folder.".into()
            }
            _ => error.to_string(),
        }),
    };
    Listing {
        path: folder.to_path_buf(),
        parent,
        folders,
    }
}

/// A place beside the list.
struct Place {
    label: SharedString,
    path: PathBuf,
    icon: IconName,
    /// False for a place the sandbox keeps Tidy out of: it shows, but cannot be opened.
    available: bool,
}

/// The places beside the list, under their headings, as Electron Oriel's `folderPlaces` finds
/// them, after Oriel RS's own two in a sandboxed run.
fn places_for(sandbox: Option<&DataRoot>) -> Vec<(SharedString, Vec<Place>)> {
    let admits = |path: &Path| sandbox.is_none_or(|data| data.admits_tidy_root(path));
    let mut groups = Vec::new();
    if let Some(data) = sandbox {
        let temp = oriel_runtime::paths::canonicalize(&std::env::temp_dir())
            .unwrap_or_else(|_| std::env::temp_dir());
        groups.push((
            "Where Tidy works".into(),
            vec![
                Place {
                    label: "Sandbox".into(),
                    path: data.sandbox(),
                    icon: IconName::Lock,
                    available: true,
                },
                Place {
                    label: "Temp folder".into(),
                    path: temp,
                    icon: IconName::FolderOpen,
                    available: true,
                },
            ],
        ));
    }
    let mut standard = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let name = home
            .file_name()
            .map_or_else(|| "Home".into(), |name| name.to_string_lossy().into_owned());
        standard.push((name, home.clone(), IconName::House));
        for (label, folder, icon) in [
            ("Desktop", "Desktop", IconName::Monitor),
            ("Documents", "Documents", IconName::FileText),
            ("Downloads", "Downloads", IconName::Download),
            ("Pictures", "Pictures", IconName::Image),
            ("Movies", "Movies", IconName::Film),
        ] {
            standard.push((label.to_string(), home.join(folder), icon));
        }
    }
    let places: Vec<Place> = standard
        .into_iter()
        .filter(|(_, path, _)| path.is_dir())
        .map(|(label, path, icon)| Place {
            label: label.into(),
            available: admits(&path),
            path,
            icon,
        })
        .collect();
    if !places.is_empty() {
        groups.push(("Places".into(), places));
    }
    let drives: Vec<Place> = list_volumes()
        .into_iter()
        .map(|entry| Place {
            label: entry.name.into(),
            available: admits(&entry.path),
            path: entry.path,
            icon: IconName::HardDrive,
        })
        .collect();
    if !drives.is_empty() {
        groups.push(("Drives".into(), drives));
    }
    groups
}

/// Mounted drives, from `/Volumes`; the startup disk shows there as a link to `/`
/// (`listVolumes`).
fn list_volumes() -> Vec<FolderEntry> {
    let Ok(entries) = std::fs::read_dir("/Volumes") else {
        return Vec::new();
    };
    let mut volumes: Vec<FolderEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("com.apple.") {
                return None;
            }
            let path = oriel_runtime::paths::canonicalize(&entry.path()).ok()?;
            path.is_dir().then_some(FolderEntry { name, path })
        })
        .collect();
    volumes.sort_by(compare_by_name);
    volumes
}

pub struct FolderPicker {
    options: PickOptions,
    on_choose: OnChoose,
    places: Vec<(SharedString, Vec<Place>)>,
    input: Entity<InputState>,
    listing: Option<Listing>,
    highlight: Option<usize>,
    /// The folder the field names, when it is not the one listed yet.
    typed_folder: Option<PathBuf>,
    query: String,
    /// Writing the field from a listing must not list again.
    retyping: bool,
    listing_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl FolderPicker {
    pub fn new(
        options: PickOptions,
        on_choose: OnChoose,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let places = if options.within.is_none() {
            places_for(options.sandbox.as_ref())
        } else {
            Vec::new()
        };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Folder path"));
        let subscriptions = vec![cx.subscribe_in(&input, window, Self::on_input)];
        let start = options
            .start
            .clone()
            .filter(|start| start.is_dir())
            .or_else(|| options.within.as_ref().map(|(path, _)| path.clone()))
            .or_else(|| {
                places
                    .iter()
                    .flat_map(|(_, places)| places)
                    .find(|place| place.available)
                    .map(|place| place.path.clone())
            })
            .unwrap_or_else(|| PathBuf::from("/"));
        let select = options.select.clone();
        let mut picker = Self {
            options,
            on_choose,
            places,
            input,
            listing: None,
            highlight: None,
            typed_folder: None,
            query: String::new(),
            retyping: false,
            listing_task: None,
            _subscriptions: subscriptions,
        };
        picker.open(start, true, select, window, cx);
        picker
    }

    pub fn listing(&self) -> Option<&Listing> {
        self.listing.as_ref()
    }

    /// The folder the primary button would choose: the highlighted one, else the one listed.
    pub fn chosen(&self) -> Option<PathBuf> {
        if let Some(entry) = self.target() {
            return Some(entry.path.clone());
        }
        let listing = self.listing.as_ref()?;
        (listing.folders.is_ok() && self.typed_folder.is_none()).then(|| listing.path.clone())
    }

    /// Whether `folder` may be chosen: inside `within`, or inside the sandbox for a folder to
    /// tidy.
    pub fn admits(&self, folder: &Path) -> bool {
        if let Some((within, _)) = &self.options.within {
            return folder.starts_with(within);
        }
        match &self.options.sandbox {
            Some(data) => data.admits_tidy_root(folder),
            None => true,
        }
    }

    fn matches(&self) -> Vec<&FolderEntry> {
        let Some(Listing {
            folders: Ok(folders),
            ..
        }) = &self.listing
        else {
            return Vec::new();
        };
        let query = self.query.to_lowercase();
        if query.is_empty() {
            return folders.iter().collect();
        }
        let starts = folders
            .iter()
            .filter(|entry| entry.name.to_lowercase().starts_with(&query));
        let contains = folders.iter().filter(|entry| {
            let name = entry.name.to_lowercase();
            !name.starts_with(&query) && name.contains(&query)
        });
        starts.chain(contains).collect()
    }

    /// The highlighted folder; typing a name highlights the best match, so ↩ goes into it.
    fn active(&self) -> Option<usize> {
        let count = self.matches().len();
        match self.highlight {
            Some(index) if index < count => Some(index),
            _ if !self.query.is_empty() && count > 0 => Some(0),
            _ => None,
        }
    }

    fn target(&self) -> Option<&FolderEntry> {
        let index = self.active()?;
        self.matches().get(index).copied()
    }

    /// The field's text for a folder: ending in `/`, under the root's name when `within`.
    fn shown(&self, folder: &Path) -> String {
        let text = match &self.options.within {
            Some((path, name)) if folder.starts_with(path) => {
                let rest = folder.strip_prefix(path).unwrap_or(folder);
                if rest.as_os_str().is_empty() {
                    name.clone()
                } else {
                    format!("{name}/{}", rest.display())
                }
            }
            _ => folder.display().to_string(),
        };
        if text.ends_with('/') {
            text
        } else {
            format!("{text}/")
        }
    }

    /// The folder a typed path names.
    fn expanded(&self, text: &str) -> PathBuf {
        if let Some((path, name)) = &self.options.within {
            if text == name {
                return path.clone();
            }
            if let Some(rest) = text.strip_prefix(&format!("{name}/")) {
                return path.join(rest);
            }
        }
        PathBuf::from(text)
    }

    /// Lists `folder`; `retype` writes it into the path field, as a click or ↩ does.
    fn open(
        &mut self,
        folder: PathBuf,
        retype: bool,
        select: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let listed = folder.clone();
        let listing = cx
            .background_executor()
            .spawn(async move { list_folder(&listed) });
        self.listing_task = Some(cx.spawn_in(window, async move |this, cx| {
            let listing = listing.await;
            this.update_in(cx, |this, window, cx| {
                this.highlight = select.as_ref().and_then(|select| {
                    listing
                        .folders
                        .as_ref()
                        .ok()?
                        .iter()
                        .position(|entry| &entry.path == select)
                });
                if retype {
                    let text = this.shown(&listing.path);
                    this.retyping = true;
                    this.input
                        .update(cx, |input, cx| input.set_value(text, window, cx));
                    this.retyping = false;
                    this.query.clear();
                }
                this.typed_folder = None;
                this.listing = Some(listing);
                cx.notify();
            })
            .ok();
        }));
    }

    fn on_input(
        &mut self,
        input: &Entity<InputState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Change if !self.retyping => {
                let text = input.read(cx).value().to_string();
                let cut = text.rfind('/').map_or(0, |index| index + 1);
                let (folder, query) = text.split_at(cut);
                self.query = query.to_string();
                self.highlight = None;
                let wanted = (!folder.is_empty()).then(|| {
                    let path = self.expanded(folder.trim_end_matches('/'));
                    if path.as_os_str().is_empty() {
                        PathBuf::from("/")
                    } else {
                        path
                    }
                });
                let current = self.listing.as_ref().map(|listing| listing.path.clone());
                match wanted {
                    Some(wanted) if Some(&wanted) != current.as_ref() => {
                        let inside = self
                            .options
                            .within
                            .as_ref()
                            .is_none_or(|(path, _)| wanted.starts_with(path));
                        self.typed_folder = Some(wanted.clone());
                        if inside {
                            self.open(wanted, false, None, window, cx);
                        }
                    }
                    _ => self.typed_folder = None,
                }
                cx.notify();
            }
            InputEvent::PressEnter { secondary, .. } => {
                if *secondary {
                    self.choose(window, cx);
                } else if let Some(target) = self.target().cloned() {
                    self.open(target.path, true, None, window, cx);
                } else {
                    self.choose(window, cx);
                }
            }
            _ => {}
        }
    }

    fn choose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chosen) = self.chosen() else {
            return;
        };
        if !self.admits(&chosen) {
            return;
        }
        window.close_dialog(cx);
        (self.on_choose)(chosen, window, cx);
    }

    fn go_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(listing) = &self.listing else {
            return;
        };
        let at_top = listing.parent.is_none()
            || self
                .options
                .within
                .as_ref()
                .is_some_and(|(path, _)| &listing.path == path);
        if at_top {
            return;
        }
        let (parent, here) = (listing.parent.clone(), listing.path.clone());
        if let Some(parent) = parent {
            self.open(parent, true, Some(here), window, cx);
        }
    }

    fn move_highlight(&mut self, step: isize, cx: &mut Context<Self>) {
        let count = self.matches().len() as isize;
        if count == 0 {
            return;
        }
        let from = self.active().map_or(-1, |index| index as isize);
        self.highlight = Some((from + step).clamp(0, count - 1) as usize);
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keys = &event.keystroke;
        match keys.key.as_str() {
            "down" => {
                self.move_highlight(1, cx);
                cx.stop_propagation();
            }
            "up" if keys.modifiers.platform => {
                self.go_up(window, cx);
                cx.stop_propagation();
            }
            "up" => {
                self.move_highlight(-1, cx);
                cx.stop_propagation();
            }
            _ => {}
        }
    }
}

impl FolderPicker {
    /// One place beside the list: a click opens it, unless the sandbox keeps Tidy out, when it
    /// shows dimmed and says so.
    fn render_place(
        &self,
        index: usize,
        place: &Place,
        current: Option<&PathBuf>,
        rule: Option<&str>,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let theme = cx.theme();
        let here = current == Some(&place.path);
        let path = place.path.clone();
        let available = place.available;
        let tooltip: SharedString = if available {
            place.path.display().to_string().into()
        } else {
            format!(
                "{} is outside the sandbox. {}",
                place.path.display(),
                rule.unwrap_or_default()
            )
            .into()
        };
        div()
            .id(("picker-place", index))
            .test_support()
            .aria_label(place.label.clone())
            .when(!available, |this| {
                this.aria_description("Outside the sandbox")
            })
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .h(px(32.))
            .px(px(10.))
            .rounded(theme.radius)
            .text_size(px(13.))
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx)
            })
            .when(available, |this| {
                this.cursor_pointer()
                    .when(here, |this| this.bg(theme.list_active))
                    .when(!here, |this| this.hover(|style| style.bg(theme.list_hover)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open(path.clone(), true, None, window, cx);
                    }))
            })
            .when(!available, |this| {
                this.text_color(theme.muted_foreground).opacity(0.6)
            })
            .child(
                Icon::new(place.icon)
                    .size(px(16.))
                    .text_color(theme.muted_foreground),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(place.label.clone()),
            )
            .when(!available, |this| {
                this.child(
                    Icon::new(IconName::Lock)
                        .size(px(12.))
                        .text_color(theme.muted_foreground),
                )
            })
            .into_any_element()
    }
}

impl Focusable for FolderPicker {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for FolderPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let matches: Vec<FolderEntry> = self.matches().into_iter().cloned().collect();
        let active = self.active();
        let chosen = self.chosen();
        let admitted = chosen.as_ref().is_some_and(|chosen| self.admits(chosen));
        let current = self.listing.as_ref().map(|listing| listing.path.clone());
        let at_top = self.listing.as_ref().is_none_or(|listing| {
            listing.parent.is_none()
                || self
                    .options
                    .within
                    .as_ref()
                    .is_some_and(|(path, _)| &listing.path == path)
        });
        let outside_within = self.typed_folder.as_ref().is_some_and(|typed| {
            self.options
                .within
                .as_ref()
                .is_some_and(|(path, _)| !typed.starts_with(path))
        });
        let chosen_name = chosen.as_ref().map(|chosen| match &self.options.within {
            Some((path, name)) if chosen == path => name.clone(),
            _ => chosen
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| chosen.display().to_string()),
        });

        let empty: Option<String> = match &self.listing {
            None => None,
            Some(Listing {
                folders: Err(message),
                ..
            }) => Some(message.clone()),
            Some(Listing {
                folders: Ok(folders),
                ..
            }) if folders.is_empty() => Some("No folders inside".into()),
            Some(_) if matches.is_empty() => Some(format!("No folder named “{}”", self.query)),
            Some(_) => None,
        };

        let rule = self
            .options
            .sandbox
            .as_ref()
            .map(crate::links::sandbox_rule);
        let mut index = 0;
        let mut explained = false;
        let places = (!self.places.is_empty()).then(|| {
            div()
                .id("picker-places")
                .flex()
                .flex_col()
                .w(px(176.))
                .flex_shrink_0()
                .overflow_y_scroll()
                .pr_3()
                .children(self.places.iter().map(|(heading, places)| {
                    // Why the places cannot be opened, once, under the first heading of places
                    // the sandbox keeps Tidy out of; each one's tooltip says it in full.
                    let blocked = places.iter().any(|place| !place.available);
                    let explain = blocked && !explained;
                    explained |= blocked;
                    div()
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .pb_3()
                        .child(
                            div()
                                .px(px(10.))
                                .pb(px(6.))
                                .text_xs()
                                .font_weight(gpui_kit::FontWeight::MEDIUM)
                                .text_color(theme.muted_foreground)
                                .child(heading.clone()),
                        )
                        .when(explain && rule.is_some(), |this| {
                            this.child(
                                div()
                                    .id("picker-places-rule")
                                    .test_support()
                                    .px(px(10.))
                                    .pb(px(6.))
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(
                                        "With ORIEL_RS_DATA_DIR set, Tidy works only in the \
                                         sandbox and the temp folder",
                                    ),
                            )
                        })
                        .children(places.iter().map(|place| {
                            index += 1;
                            let rule = rule.as_deref();
                            self.render_place(index - 1, place, current.as_ref(), rule, cx)
                        }))
                }))
        });

        let list = div()
            .id("picker-folders")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p_1()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .bg(theme.group_box)
            .map(|this| match &empty {
                Some(message) => this.child(
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .p_6()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(message.clone()),
                ),
                None => this.children(matches.iter().enumerate().map(|(index, entry)| {
                    let highlighted = active == Some(index);
                    let path = entry.path.clone();
                    div()
                        .id(SharedString::from(format!("picker-folder-{}", entry.name)))
                        .test_support()
                        .aria_label(SharedString::from(entry.name.clone()))
                        .aria_selected(highlighted)
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .h(px(32.))
                        .px(px(10.))
                        .rounded(theme.radius)
                        .text_size(px(13.))
                        .cursor_pointer()
                        .when(highlighted, |this| this.bg(theme.list_active))
                        .when(!highlighted, |this| {
                            this.hover(|style| style.bg(theme.list_hover))
                        })
                        .on_click(cx.listener(
                            move |this, event: &gpui_kit::ClickEvent, window, cx| {
                                if event.click_count() >= 2 {
                                    this.open(path.clone(), true, None, window, cx);
                                } else {
                                    this.highlight = Some(index);
                                    cx.notify();
                                }
                            },
                        ))
                        .child(
                            Icon::new(IconName::Folder)
                                .size(px(16.))
                                .text_color(theme.muted_foreground),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .child(entry.name.clone()),
                        )
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .size(px(14.))
                                .text_color(theme.muted_foreground)
                                .when(!highlighted, |this| this.opacity(0.)),
                        )
                })),
            });

        let note = if outside_within {
            self.options
                .within
                .as_ref()
                .map(|(_, name)| format!("Choose a folder inside {name}."))
        } else if self.options.sandbox.is_some() && chosen.is_some() && !admitted {
            self.options
                .sandbox
                .as_ref()
                .map(crate::links::sandbox_rule)
        } else {
            None
        };

        let action = match &chosen_name {
            Some(name) => format!("{} “{name}”", self.options.action),
            None => self.options.action.to_string(),
        };

        div()
            .id("folder-picker")
            .key_context("FolderPicker")
            .on_key_down(cx.listener(Self::on_key_down))
            .flex()
            .flex_col()
            .gap_3()
            .w_full()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .h(px(400.))
                    .min_h_0()
                    .children(places)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap_2()
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        Button::new("picker-up")
                                            .bar_size()
                                            .outline()
                                            .icon(Icon::new(IconName::ArrowUp))
                                            .accessibility_label("Enclosing folder")
                                            .tooltip("Enclosing folder  ⌘↑")
                                            .disabled(at_top)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.go_up(window, cx);
                                            })),
                                    )
                                    .child(
                                        div().flex_1().child(Input::new(&self.input).bar_size()),
                                    ),
                            )
                            .when_some(note, |this, note| {
                                this.child(
                                    div()
                                        .id("picker-note")
                                        .test_support()
                                        .aria_label(SharedString::from(note.clone()))
                                        .px_1()
                                        .text_xs()
                                        .text_color(theme.warning)
                                        .child(note),
                                )
                            })
                            .child(list),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(
                                chosen
                                    .as_ref()
                                    .map(|chosen| chosen.display().to_string())
                                    .unwrap_or_default(),
                            ),
                    )
                    .child(
                        Button::new("picker-cancel")
                            .bar_size()
                            .outline()
                            .label("Cancel")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
                        Button::new("picker-choose")
                            .bar_size()
                            .primary()
                            .label(action)
                            .child(crate::widgets::key_hint("⌘↩"))
                            .tooltip(format!("{}  ⌘↩", self.options.action))
                            .disabled(!admitted)
                            .on_click(cx.listener(|this, _, window, cx| this.choose(window, cx))),
                    ),
            )
    }
}

/// Opens a picker over the window; `on_choose` gets the folder chosen.
pub fn open(
    options: PickOptions,
    window: &mut Window,
    cx: &mut App,
    on_choose: impl Fn(PathBuf, &mut Window, &mut App) + 'static,
) {
    // One picker at a time: ⌘O while it is open does nothing.
    if window.has_active_dialog(cx) {
        return;
    }
    let title = options.title.clone();
    let width = if options.within.is_some() { 560. } else { 760. };
    let picker = cx.new(|cx| FolderPicker::new(options, Rc::new(on_choose), window, cx));
    let focus = picker.read(cx).focus_handle(cx);
    window.open_dialog(cx, move |dialog, _, _| {
        dialog
            .title(title.clone())
            .w(px(width))
            .child(picker.clone())
    });
    focus.focus(window, cx);
}
