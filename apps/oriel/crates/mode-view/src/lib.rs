//! View: a folder's media as a gallery, the viewer, the capsule player and the comic reader.
//!
//! View reads; it never writes inside a folder it shows. What it keeps goes under
//! `DataRoot::view()`: the settings file, the thumbnails and the prime clip.
//!
//! [`ViewMode`] holds the session: the folder on screen and the one the owner opened (above
//! which View does not step), whether the listing is recursive, and the overlays. The scan is
//! [`catalog::Catalog`]'s, the grid [`Gallery`]'s, and the rules (order, comics, the gallery's
//! entries) `oriel-core-domain`'s.

pub mod browser;
pub mod catalog;
mod chrome;
mod comic_reader;
pub mod folder_overlay;
pub mod gallery;
mod header;
pub mod listing;
mod media_tools;
mod player;
mod settings;
mod settings_section;
mod shortcuts;
mod sidebar;
mod spike;
mod stills;
pub mod thumbnails;
mod toolbar;
pub mod viewer;

pub use gallery::{Gallery, Listing};
pub use media_tools::ViewMediaTools;
pub use player::{CapsulePanel, CapsulePlayer, PlayerOptions};
pub use viewer::Viewer;

use comic_reader::{ComicReader, ComicReaderEvent};
use folder_overlay::{FolderOverlay, FolderOverlayEvent};
use gallery::{Activation, FolderStep, GalleryEvent, PreviewSettings};
use viewer::ViewerEvent;

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher as _, Hasher as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, ExternalPaths, FocusHandle, Focusable as _,
    Global, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _,
    PathPromptOptions, Render, SharedString, Styled as _, Subscription, Task, Window, actions, div,
    prelude::FluentBuilder as _, px,
};
use oriel_core_domain::{GallerySortMode, folder_key};
use oriel_launch::Launch;
use oriel_ui::shortcuts::Sheet;
use oriel_ui::{
    ActivityJob, Command, FolderSetUp, Foot, HandOff, MenuSlot, Mode, ModeActivity, ModeId,
    ModeLayout, ModeReporter, ShellState, Toast, ToastExt as _, Work,
};

use crate::browser::{Browse, Comic, Tile, build_comics, build_tiles, sort_media};
use crate::catalog::{Catalog, CatalogUpdate, ScanRequest, ScanState};
use crate::gallery::metrics::TileAspect;
use crate::listing::{MediaEntry, resolve_folder_path, scan_filters};
use crate::settings::{FileFilterSettings, SettingsStore, ViewSettings};

/// Marks View's keys as bound, so a second window does not bind them twice.
struct ViewKeys;

impl Global for ViewKeys {}

actions!(
    view,
    [
        /// The system's folder picker, and the folder chosen opened.
        OpenFolder,
        /// The folder on screen read again.
        Refresh
    ]
);

/// Binds the keys of View's parts. `ViewMode::new` calls it.
fn init(cx: &mut App) {
    if cx.has_global::<ViewKeys>() {
        return;
    }
    cx.set_global(ViewKeys);
    viewer::bind_keys(cx);
    gallery::bind_keys(cx);
    comic_reader::bind_keys(cx);
    folder_overlay::bind_keys(cx);
}

/// A file handed to View, to open in the viewer once its folder's scan has listed it.
struct PendingFocus {
    folder: Arc<Path>,
    file: PathBuf,
}

/// The sorted media of one listing, kept until the items or the order change.
#[derive(Default)]
struct SortedMedia {
    key: Option<(u64, GallerySortMode, i64)>,
    media: Arc<[MediaEntry]>,
}

pub struct ViewMode {
    shell: Entity<ShellState>,
    reporter: ModeReporter,
    settings: SettingsStore,
    catalog: Entity<Catalog>,
    gallery: Entity<Gallery>,
    viewer: Option<Entity<Viewer>>,
    /// The open viewer's close event, dropped with it.
    viewer_subscription: Option<Subscription>,
    /// Where focus was before an overlay took it, to give it back on close.
    focus_before_overlay: Option<FocusHandle>,
    /// The Folders button's, for focus to come back to when its overlay closes.
    folders_button: FocusHandle,
    comic_reader: Option<(Entity<ComicReader>, Subscription)>,
    folder_overlay: Option<(Entity<FolderOverlay>, Subscription)>,
    sort_menu_open: bool,
    /// The session's recursive switch, before the folder's comic mode is applied
    /// (`Recursive is per session`, plan 057 decision 9).
    recursive: bool,
    /// The folder the owner opened, above which View does not step.
    navigation_ceiling: Option<Arc<Path>>,
    /// A folder tile to select once its parent lists, after stepping up out of it.
    pending_selection: Option<SharedString>,
    pending_focus: Option<PendingFocus>,
    /// The media item to open the viewer on at the next frame, once a handed-over file lists.
    pending_open_viewer: Option<usize>,
    /// The folder the thumbnails were last asked for, so a new folder starts their queue over.
    thumbnails_root: Option<Arc<Path>>,
    sorted: SortedMedia,
    pub(crate) settings_panel: settings_section::SettingsPanel,
    pub(crate) spike: Option<spike::Spike>,
    _subscriptions: Vec<Subscription>,
}

/// How much of the window's foot the gallery's toolbar and the player's capsule take.
const FOOT_HEIGHT: f32 = 84.;

impl ViewMode {
    /// View keeping its data under the launch's data root. It opens the launch's folder or file,
    /// if there is one, and the remembered folder otherwise; the spikes the launch asks for run.
    pub fn new(
        shell: &Entity<ShellState>,
        launch: &Launch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init(cx);
        let data = &launch.data;
        let settings = SettingsStore::load(&data.view_settings());
        let recursive = settings.settings().recursive_default;
        let gallery =
            cx.new(|cx| Gallery::new(shell, data.view_thumbnails(), data.view_cache(), cx));
        let catalog = cx.new(|_| Catalog::default());
        // The media index View no longer keeps (dropped November 2026). Delete this sweep one
        // release after that, once launches have cleared it.
        let retired = data.retired_view_media_index();
        cx.background_spawn(async move {
            for path in retired {
                if let Err(error) = std::fs::remove_file(&path)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    log::warn!("cannot delete {}: {error}", path.display());
                }
            }
        })
        .detach();
        let subscriptions = vec![
            cx.observe(shell, |this, shell, cx| {
                // Off screen, a hover preview has no pointer left to stop it.
                if !shell.read(cx).shows(ModeId::View) {
                    this.gallery
                        .update(cx, |gallery, cx| gallery.stop_preview(cx));
                }
                cx.notify();
            }),
            // Back on screen with the viewer or the reader open, View gives it the keys again,
            // so Escape and the arrows reach it: another mode may have taken them meanwhile.
            // Leaving the screen, it pauses the viewer's video, and their chrome stops fading,
            // which would hide the pointer over the mode or the Settings page on screen.
            cx.observe_in(shell, window, {
                let mut shown = shell.read(cx).shows(ModeId::View);
                move |this, shell, window, cx| {
                    let now = shell.read(cx).shows(ModeId::View);
                    if now && !shown {
                        this.focus_overlay(window, cx);
                        this.overlay_chrome(true, window, cx);
                    } else if shown && !now {
                        this.pause_video(window, cx);
                        this.overlay_chrome(false, window, cx);
                    }
                    shown = now;
                }
            }),
            cx.observe(&catalog, |this, _, cx| this.catalog_changed(cx)),
            cx.subscribe(&catalog, Self::on_catalog_update),
            cx.observe(&gallery, |_, _, cx| cx.notify()),
            cx.subscribe_in(&gallery, window, Self::on_gallery_event),
        ];
        let thumbnails_entity = gallery.read(cx).thumbnails().clone();
        let thumbnail_observer = cx.observe(&thumbnails_entity, |this, _, cx| {
            this.report_activity(cx);
        });

        let mut view = Self {
            shell: shell.clone(),
            reporter: ModeReporter::new(shell, ModeId::View),
            settings,
            catalog,
            gallery,
            viewer: None,
            viewer_subscription: None,
            focus_before_overlay: None,
            folders_button: cx.focus_handle().tab_stop(true),
            comic_reader: None,
            folder_overlay: None,
            sort_menu_open: false,
            recursive,
            navigation_ceiling: None,
            pending_selection: None,
            pending_focus: None,
            pending_open_viewer: None,
            thumbnails_root: None,
            sorted: SortedMedia::default(),
            settings_panel: settings_section::SettingsPanel::new(window, cx),
            spike: None,
            _subscriptions: subscriptions,
        };
        view._subscriptions.push(thumbnail_observer);
        view.settings_panel
            .sync(view.settings.settings(), window, cx);
        view.apply_display_settings(cx);
        view.spike = spike::Spike::start(&launch.variables, window, cx);
        match launch.open.clone() {
            Some(path) => view.open_path(path, window, cx),
            None => view.restore_last_folder(cx),
        }
        view
    }

    pub fn gallery(&self) -> &Entity<Gallery> {
        &self.gallery
    }

    /// The overlay on top, the one that takes the keys: the viewer, the comic reader or the
    /// folder overlay, if one is open.
    fn overlay_focus(&self, cx: &App) -> Option<FocusHandle> {
        if let Some(viewer) = &self.viewer {
            Some(viewer.focus_handle(cx))
        } else if let Some((reader, _)) = &self.comic_reader {
            Some(reader.focus_handle(cx))
        } else {
            self.folder_overlay
                .as_ref()
                .map(|(overlay, _)| overlay.focus_handle(cx))
        }
    }

    /// Gives the keys to the overlay on top, if one is open and does not have them.
    fn focus_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(focus) = self.overlay_focus(cx) else {
            return;
        };
        if !focus.contains_focused(window, cx) {
            cx.defer_in(window, move |_, window, cx| focus.focus(window, cx));
        }
    }

    pub fn catalog(&self) -> &Entity<Catalog> {
        &self.catalog
    }

    pub fn viewer(&self) -> Option<&Entity<Viewer>> {
        self.viewer.as_ref()
    }

    pub fn comic_reader(&self) -> Option<&Entity<ComicReader>> {
        self.comic_reader.as_ref().map(|(reader, _)| reader)
    }

    pub fn folder_overlay(&self) -> Option<&Entity<FolderOverlay>> {
        self.folder_overlay.as_ref().map(|(overlay, _)| overlay)
    }

    pub fn settings(&self) -> &ViewSettings {
        self.settings.settings()
    }

    /// The session's recursive switch, with the folder's comic mode applied.
    pub fn is_recursive(&self, cx: &App) -> bool {
        self.effective_recursive(&self.current_preferences(cx))
    }

    /// Whether a folder with `preferences` lists recursively: comic mode lists its comics'
    /// pages, whatever the session's switch says.
    pub(crate) fn effective_recursive(
        &self,
        preferences: &settings::RootGalleryPreferences,
    ) -> bool {
        self.recursive || preferences.comic_mode
    }

    pub fn comic_mode(&self, cx: &App) -> bool {
        self.current_preferences(cx).comic_mode
    }

    /// The folder on screen.
    pub fn folder(&self, cx: &App) -> Option<Arc<Path>> {
        self.catalog.read(cx).root().cloned()
    }

    /// The folder View works on, as the other modes are offered it: the one the
    /// owner opened while the last folder is inside it, else the last folder. `None` until View
    /// has opened one, or while it remembers none.
    pub fn opened_folder(&self) -> Option<PathBuf> {
        let settings = self.settings.settings();
        let last = settings.last_folder_path.as_deref()?;
        let opened = settings
            .last_opened_folder_path
            .as_deref()
            .filter(|opened| Path::new(last).starts_with(opened));
        Some(PathBuf::from(opened.unwrap_or(last)))
    }

    fn current_preferences(&self, cx: &App) -> settings::RootGalleryPreferences {
        let catalog = self.catalog.read(cx);
        self.settings
            .settings()
            .root_preferences(catalog.root().map(AsRef::as_ref))
    }

    /// Opens a path the OS, another mode or a launch variable hands View: a folder, or a file,
    /// whose folder opens with the file in the viewer once the scan lists it. The shell routes
    /// paths opened with the app here.
    pub fn open_path(&mut self, path: PathBuf, _: &mut Window, cx: &mut Context<Self>) {
        let Some(folder) = resolve_folder_path(&path) else {
            self.catalog.update(cx, |catalog, cx| {
                catalog.fail("Invalid folder path", Some(&path), cx);
            });
            return;
        };
        self.leave_overlays();
        self.pending_focus = path.is_file().then(|| PendingFocus {
            folder: folder.clone().into(),
            file: oriel_runtime::paths::canonicalize(&path).unwrap_or(path),
        });
        self.start_scan_at(folder, cx);
    }

    /// Closes the viewer and the reader for a folder opened over them (from the menu, a drop,
    /// or another mode): it replaces what they show. A file handed over opens the viewer again
    /// once its folder lists. Focus goes to the gallery at the next frame.
    fn leave_overlays(&mut self) {
        self.viewer = None;
        self.viewer_subscription = None;
        self.comic_reader = None;
        self.focus_before_overlay = None;
    }

    /// Opens `folder` as one the owner chose: it becomes the top View steps up to, and the
    /// folder View starts at again.
    pub fn open_folder(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        match resolve_folder_path(&folder) {
            Some(folder) => {
                self.leave_overlays();
                self.start_scan_at(folder, cx);
            }
            None => self.catalog.update(cx, |catalog, cx| {
                catalog.fail("Invalid folder path", Some(&folder), cx);
            }),
        }
    }

    /// Asks for a folder with the system's picker, and opens it: the Open button, and File ›
    /// Open Folder… (⌘O) once the shell's menu calls it.
    pub fn choose_folder(&mut self, cx: &mut Context<Self>) {
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

    /// Scans a folder the owner chose: it is the new top and the remembered folder.
    fn start_scan_at(&mut self, folder: PathBuf, cx: &mut Context<Self>) {
        self.navigation_ceiling = Some(folder.clone().into());
        self.pending_selection = None;
        if self.settings.settings().remember_last_folder {
            let remembered = folder.to_string_lossy().into_owned();
            self.update_settings(cx, |settings| {
                settings.last_opened_folder_path = Some(remembered.clone());
                settings.last_folder_path = Some(remembered);
            });
        }
        self.run_scan(&folder, ScanOptions::default(), cx);
    }

    /// Back where the owner left off at the last start, with the folder they opened still the
    /// top when the last folder is inside it.
    fn restore_last_folder(&mut self, cx: &mut Context<Self>) {
        let settings = self.settings.settings().clone();
        let Some(last) = settings
            .last_folder_path
            .clone()
            .filter(|_| settings.remember_last_folder)
        else {
            return;
        };
        let canonical = |path: &str| {
            let path = PathBuf::from(path);
            oriel_runtime::paths::canonicalize(&path).unwrap_or(path)
        };
        let last = canonical(&last);
        let ceiling = settings
            .last_opened_folder_path
            .as_deref()
            .map(canonical)
            .filter(|opened| last.starts_with(opened))
            .unwrap_or_else(|| last.clone());
        self.navigation_ceiling = Some(ceiling.into());
        let preferences = settings.root_preferences(Some(&last));
        self.recursive = settings.recursive_default || preferences.comic_mode;
        self.run_scan(
            &last,
            ScanOptions {
                recursive: Some(self.recursive),
                ..ScanOptions::default()
            },
            cx,
        );
    }

    /// Options left out come from the scanned folder's own preferences.
    fn run_scan(&mut self, folder: &Path, options: ScanOptions, cx: &mut Context<Self>) {
        let settings = self.settings.settings();
        let folder_text = folder.to_string_lossy().into_owned();
        let preferences = settings.root_preferences(Some(folder));
        let recursive = options
            .recursive
            .unwrap_or(self.effective_recursive(&preferences));
        let filters = options.filters.unwrap_or_else(|| settings.filters.clone());
        let excluded = options
            .excluded
            .unwrap_or(preferences.excluded_root_child_paths);
        let order = (settings.sort_mode, settings.random_seed);
        if settings.remember_last_folder
            && settings.last_folder_path.as_deref() != Some(&folder_text)
        {
            self.update_settings(cx, |settings| settings.last_folder_path = Some(folder_text));
        }
        let request = ScanRequest {
            root: folder.to_path_buf(),
            recursive,
            filters: scan_filters(&filters),
            excluded_root_children: excluded.into_iter().map(PathBuf::from).collect(),
            order,
        };
        self.catalog
            .update(cx, |catalog, cx| catalog.scan(request, cx));
        self.report_activity(cx);
    }

    /// Changes View's settings and writes them off the main thread.
    fn update_settings(&mut self, cx: &mut Context<Self>, change: impl FnOnce(&mut ViewSettings)) {
        let write = self.settings.update(change);
        cx.background_spawn(async move { write() }).detach();
        self.apply_display_settings(cx);
        cx.notify();
    }

    /// Changes settings the owner set in Settings: filters repeat the latest scan with them, and
    /// the rest apply at once.
    pub(crate) fn change_settings(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut ViewSettings),
    ) {
        let filters_before = self.settings.settings().filters.clone();
        self.update_settings(cx, change);
        self.settings_panel
            .sync(self.settings.settings(), window, cx);
        let filters = self.settings.settings().filters.clone();
        if filters != filters_before
            && let Some(request) = self.catalog.read(cx).requested().cloned()
        {
            self.run_scan(
                &request.root,
                ScanOptions {
                    recursive: Some(request.recursive),
                    filters: Some(filters),
                    excluded: Some(
                        request
                            .excluded_root_children
                            .iter()
                            .map(|path| path.to_string_lossy().into_owned())
                            .collect(),
                    ),
                },
                cx,
            );
        }
    }

    /// The thumbnail size, the order, what video tiles do under the pointer and what the
    /// thumbnail service records follow the settings.
    fn apply_display_settings(&mut self, cx: &mut Context<Self>) {
        let settings = self.settings.settings();
        let size = settings.thumbnail_size as f32;
        let preview = PreviewSettings {
            autoplay: settings.autoplay_on_hover,
            sound: settings.preview_audio_enabled,
            looping: settings.loop_videos,
        };
        // Diagnostics' switches: the thumbnail service's events to the terminal, and its timings.
        let debug = thumbnails::DebugOptions {
            logging: settings.debug.enable_debug_logging,
            monitoring: settings.debug.enable_performance_monitoring,
        };
        self.gallery.update(cx, |gallery, cx| {
            gallery.set_thumbnail_size(size, cx);
            gallery.set_preview_settings(preview, cx);
            gallery
                .thumbnails()
                .update(cx, |thumbnails, _| thumbnails.set_debug(debug));
        });
        self.rebuild_tiles(cx);
    }

    fn catalog_changed(&mut self, cx: &mut Context<Self>) {
        self.rebuild_tiles(cx);
        self.report_activity(cx);
        cx.notify();
    }

    fn on_catalog_update(
        &mut self,
        _: Entity<Catalog>,
        update: &CatalogUpdate,
        cx: &mut Context<Self>,
    ) {
        match update {
            CatalogUpdate::Reset => {
                let root = self.catalog.read(cx).root().cloned();
                if root != self.thumbnails_root {
                    // A new folder: back to the top, and its thumbnails' queue starts over.
                    self.thumbnails_root = root;
                    self.gallery
                        .update(cx, |gallery, cx| gallery.reset_folder(cx));
                }
            }
            CatalogUpdate::Done => {
                self.rebuild_tiles(cx);
                self.open_pending_focus(cx);
            }
        }
    }

    /// A file handed to View opens in the viewer once its folder's scan lists it.
    fn open_pending_focus(&mut self, cx: &mut Context<Self>) {
        let Some(focus) = self.pending_focus.take() else {
            return;
        };
        if self.catalog.read(cx).root() != Some(&focus.folder) {
            return;
        }
        let media = self.gallery.read(cx).media().clone();
        if let Some(ix) = media
            .iter()
            .position(|entry| entry.path().as_ref() == focus.file)
        {
            self.gallery
                .update(cx, |gallery, cx| gallery.reveal(ix, cx));
            self.pending_open_viewer = Some(ix);
            cx.notify();
        }
    }

    /// What the shell shows of View's work: on the switcher, a dot while a scan runs or
    /// thumbnails are made; in the activity panel, the scan, with what it has found so far.
    /// Thumbnails stay out of the panel: they are made for the tiles on screen as the gallery
    /// scrolls, so they would come and go there with every scroll.
    fn report_activity(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let scanning = catalog.is_scanning();
        let thumbnailing = !self.gallery.read(cx).thumbnails().read(cx).is_idle();
        let activity = (scanning || thumbnailing).then_some(ModeActivity::Working);
        let jobs: Vec<ActivityJob> = scanning
            .then(|| {
                let label = match catalog.root() {
                    Some(root) => format!("Scanning {}", gallery::display_name(root)),
                    None => "Scanning folder".to_owned(),
                };
                let found = catalog.items().len();
                let job = ActivityJob::new("scan", label);
                if found > 0 {
                    job.detail(format!("{found} found"))
                } else {
                    job
                }
            })
            .into_iter()
            .collect();
        self.reporter.report(
            Work {
                shown: activity,
                holds_quit: false,
                jobs,
            },
            cx,
        );
    }

    /// The gallery's tiles for the catalog and settings as they are: `buildBrowserEntryCollection`
    /// over the sorted items, or over the items found so far while a scan runs.
    fn rebuild_tiles(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let settings = self.settings.settings();
        let root = catalog
            .root()
            .map(|root| root.to_string_lossy().into_owned());
        let preferences = settings.root_preferences(catalog.root().map(AsRef::as_ref));
        let comic_mode = preferences.comic_mode;
        let recursive = self.effective_recursive(&preferences);
        let loading = catalog.state() == ScanState::Loading;
        let (mode, seed) = (settings.sort_mode, settings.random_seed);

        let media: Arc<[MediaEntry]> = if loading {
            catalog.items().to_vec().into()
        } else {
            let key = (catalog.revision(), mode, seed);
            if self.sorted.key != Some(key) {
                // The scan sorted its items as it finished, unless the order changed since.
                let media = match catalog.sorted((mode, seed)) {
                    Some(sorted) => sorted.clone(),
                    None => sort_media(catalog.items(), mode, seed).into(),
                };
                self.sorted = SortedMedia {
                    key: Some(key),
                    media,
                };
            }
            self.sorted.media.clone()
        };
        let comics: Vec<Arc<Comic>> = if comic_mode && !loading {
            build_comics(&media, root.as_deref(), mode, seed)
        } else {
            Vec::new()
        };
        let tiles: Arc<[Tile]> = build_tiles(&Browse {
            folders: catalog.children(),
            media: &media,
            comics: &comics,
            recursive,
            comic_mode,
            sort_mode: mode,
        })
        .into();
        let listed = match (catalog.root(), catalog.state()) {
            (None, ScanState::Error) => Listing::Failed(catalog.message().clone()),
            (None, _) => Listing::Empty,
            (Some(_), ScanState::Loading) => Listing::Loading,
            (Some(_), _) => Listing::Listed,
        };
        let empty_message: SharedString = match root.as_deref().map(Path::new) {
            None => gallery::EMPTY_MESSAGE.into(),
            Some(_) if catalog.children_loading() || loading => {
                "Checking folder contents...".into()
            }
            Some(root) if comic_mode => {
                format!("No comics found in {}.", gallery::display_name(root)).into()
            }
            Some(root) => format!(
                "No media or subfolders found in {}.",
                gallery::display_name(root)
            )
            .into(),
        };
        let prefer = self.pending_selection.clone();
        if prefer
            .as_ref()
            .is_some_and(|key| tiles.iter().any(|tile| tile.key() == key))
        {
            self.pending_selection = None;
        }
        let aspect = if comic_mode {
            TileAspect::Tall
        } else {
            TileAspect::Wide
        };
        self.gallery.update(cx, |gallery, cx| {
            gallery.set_listing(listed, empty_message, cx);
            gallery.set_tiles(tiles, media, aspect, prefer, cx);
        });
    }

    fn on_gallery_event(
        &mut self,
        _: &Entity<Gallery>,
        event: &GalleryEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            GalleryEvent::Activated(Activation::Media(ix)) => self.open_viewer(*ix, window, cx),
            GalleryEvent::Activated(Activation::Folder(path)) => {
                self.navigate_to_folder(path.clone(), None, cx);
            }
            GalleryEvent::Activated(Activation::Comic(comic)) => {
                self.open_comic(comic.clone(), window, cx);
            }
            GalleryEvent::FolderStep(FolderStep::Parent) => self.open_parent_folder(cx),
            GalleryEvent::FolderStep(FolderStep::Previous) => self.open_sibling_folder(-1, cx),
            GalleryEvent::FolderStep(FolderStep::Next) => self.open_sibling_folder(1, cx),
            GalleryEvent::Selected => cx.notify(),
            GalleryEvent::OpenOffered(folder) => self.open_folder(folder.clone(), cx),
            GalleryEvent::OpenChosen => self.choose_folder(cx),
        }
    }

    /// Another folder inside the opened one; the top stays.
    pub(crate) fn navigate_to_folder(
        &mut self,
        folder: PathBuf,
        select_after: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.pending_selection = select_after;
        self.run_scan(&folder, ScanOptions::default(), cx);
    }

    /// The folder above the one on screen, while it is inside the opened one. Both are canonical
    /// paths, so they compare as the file system names them.
    pub(crate) fn parent_folder(&self, cx: &App) -> Option<PathBuf> {
        let root = self.catalog.read(cx).root()?;
        let parent = root.parent()?;
        let ceiling = self.navigation_ceiling.as_ref()?;
        parent.starts_with(ceiling).then(|| parent.to_path_buf())
    }

    pub(crate) fn open_parent_folder(&mut self, cx: &mut Context<Self>) {
        let Some(parent) = self.parent_folder(cx) else {
            return;
        };
        let current = self
            .catalog
            .read(cx)
            .root()
            .map(|root| SharedString::from(folder_key(&root.to_string_lossy())));
        self.navigate_to_folder(parent, current, cx);
    }

    /// The previous (`-1`) or next (`1`) sibling, unless the folder on screen is the top.
    pub(crate) fn sibling_folder(&self, direction: isize, cx: &App) -> Option<PathBuf> {
        let catalog = self.catalog.read(cx);
        let root = catalog.root()?;
        if self.navigation_ceiling.as_ref() == Some(root) {
            return None;
        }
        let siblings = catalog.siblings();
        let current = siblings
            .iter()
            .position(|sibling| Path::new(&sibling.path) == root.as_ref())?;
        let next = current.checked_add_signed(direction)?;
        siblings
            .get(next)
            .map(|sibling| PathBuf::from(&sibling.path))
    }

    pub(crate) fn open_sibling_folder(&mut self, direction: isize, cx: &mut Context<Self>) {
        if let Some(folder) = self.sibling_folder(direction, cx) {
            self.navigate_to_folder(folder, None, cx);
        }
    }

    /// Per session. Turning it off turns the folder's comic mode off too.
    pub(crate) fn set_recursive(&mut self, recursive: bool, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        self.recursive = recursive;
        let preferences = self.current_preferences(cx);
        if !recursive && preferences.comic_mode {
            self.update_settings(cx, |settings| {
                settings.update_root(&root, |preferences| preferences.comic_mode = false);
            });
            self.close_comic_now(cx);
        }
        self.run_scan(
            &root,
            ScanOptions {
                recursive: Some(recursive),
                excluded: Some(preferences.excluded_root_child_paths),
                ..ScanOptions::default()
            },
            cx,
        );
    }

    /// Comic on forces recursive on, comic off turns it back off.
    pub(crate) fn set_comic_mode(&mut self, comic_mode: bool, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        self.update_settings(cx, |settings| {
            settings.update_root(&root, |preferences| preferences.comic_mode = comic_mode);
        });
        self.recursive = comic_mode;
        if !comic_mode {
            self.close_comic_now(cx);
        }
        let excluded = self.current_preferences(cx).excluded_root_child_paths;
        self.run_scan(
            &root,
            ScanOptions {
                recursive: Some(comic_mode),
                excluded: Some(excluded),
                ..ScanOptions::default()
            },
            cx,
        );
    }

    /// Saved for the opened folder, and the latest recursive scan of
    /// it repeated without the excluded children.
    pub(crate) fn toggle_excluded_child(&mut self, child: &Path, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        let child = child.to_string_lossy().into_owned();
        self.update_settings(cx, |settings| {
            settings.update_root(&root, |preferences| preferences.toggle_excluded(&child));
        });
        let excluded = self.current_preferences(cx).excluded_root_child_paths;
        if let Some(overlay) = self.folder_overlay() {
            overlay.update(cx, |overlay, cx| overlay.set_excluded(excluded.clone(), cx));
        }
        let request = self.catalog.read(cx).requested().cloned();
        if let Some(request) = request
            && request.root == root.as_ref()
            && request.recursive
        {
            self.run_scan(
                &root,
                ScanOptions {
                    recursive: Some(true),
                    excluded: Some(excluded),
                    ..ScanOptions::default()
                },
                cx,
            );
        }
    }

    pub(crate) fn set_sort_mode(&mut self, mode: GallerySortMode, cx: &mut Context<Self>) {
        self.sort_menu_open = false;
        self.update_settings(cx, |settings| settings.sort_mode = mode);
    }

    /// Shuffle: a new random order, never the one on screen.
    pub(crate) fn shuffle(&mut self, cx: &mut Context<Self>) {
        let current = self.settings.settings().random_seed;
        let mut seed = random_seed();
        while seed == current {
            seed = random_seed();
        }
        self.update_settings(cx, |settings| settings.random_seed = seed);
    }

    /// Scans the folder on screen again: Refresh, and View › Refresh (⌘R) once the shell's menu
    /// calls it.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if let Some(root) = self.catalog.read(cx).root().cloned() {
            self.run_scan(&root, ScanOptions::default(), cx);
        }
    }

    /// Starts the viewer's and the reader's chrome fading again, as View comes back on screen,
    /// or stops it, as View leaves.
    fn overlay_chrome(&mut self, fading: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(viewer) = &self.viewer {
            viewer.update(cx, |viewer, cx| {
                if fading {
                    viewer.reveal_chrome(window, cx);
                } else {
                    viewer.stop_fading();
                }
            });
        }
        if let Some((reader, _)) = &self.comic_reader {
            reader.update(cx, |reader, cx| {
                if fading {
                    reader.reveal_chrome(window, cx);
                } else {
                    reader.stop_fading();
                }
            });
        }
    }

    /// Pauses the video the viewer shows, if it plays.
    fn pause_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let player = self
            .viewer
            .as_ref()
            .and_then(|viewer| viewer.read(cx).player().cloned());
        if let Some(player) = player {
            player.update(cx, |player, cx| player.pause(window, cx));
        }
    }

    /// Opens the viewer on item `ix` of the gallery's media.
    pub fn open_viewer(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.gallery.read(cx).media().clone();
        self.open_viewer_with(entries, ix, window, cx);
    }

    /// Opens the viewer on item `ix` of `entries`, which stepping walks through.
    pub(crate) fn open_viewer_with(
        &mut self,
        entries: Arc<[MediaEntry]>,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if ix >= entries.len() {
            return;
        }
        self.gallery
            .update(cx, |gallery, cx| gallery.stop_preview(cx));
        let settings = self.settings.settings();
        let options = viewer::ViewerOptions {
            wrap: settings.loop_viewer_navigation,
            autoplay: settings.autoplay_videos,
            loop_videos: settings.loop_videos,
        };
        let viewer = cx.new(|cx| Viewer::new(entries, ix, options, window, cx));
        let closed = cx.subscribe_in(&viewer, window, |this, _, event, window, cx| match event {
            ViewerEvent::Closed(ix) => this.close_viewer(*ix, window, cx),
            ViewerEvent::Stepped(ix) => {
                let ix = *ix;
                this.gallery
                    .update(cx, |gallery, cx| gallery.reveal(ix, cx));
            }
            ViewerEvent::ShowInTidy(path) => {
                let target = HandOff::File(path.clone());
                this.shell
                    .update(cx, |shell, cx| shell.hand_off(ModeId::Tidy, target, cx));
            }
        });
        self.viewer_subscription = Some(closed);
        if self.focus_before_overlay.is_none() {
            self.focus_before_overlay = window.focused(cx);
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
        self.restore_focus(window, cx);
        cx.notify();
    }

    fn restore_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.focus_before_overlay.take() {
            Some(focus) => focus.focus(window, cx),
            None => self.gallery.read(cx).focus_handle(cx).focus(window, cx),
        }
    }

    fn open_comic(&mut self, comic: Arc<Comic>, window: &mut Window, cx: &mut Context<Self>) {
        self.gallery
            .update(cx, |gallery, cx| gallery.stop_preview(cx));
        let reader = cx.new(|cx| ComicReader::new(comic, window, cx));
        let subscription = cx.subscribe_in(&reader, window, |this, _, event, window, cx| {
            let ComicReaderEvent::Closed = event;
            this.comic_reader = None;
            this.restore_focus(window, cx);
            cx.notify();
        });
        if self.focus_before_overlay.is_none() {
            self.focus_before_overlay = window.focused(cx);
        }
        reader.focus_handle(cx).focus(window, cx);
        self.comic_reader = Some((reader, subscription));
        cx.notify();
    }

    fn close_comic_now(&mut self, cx: &mut Context<Self>) {
        if self.comic_reader.take().is_some() {
            cx.notify();
        }
    }

    /// Folders: the browser over the opened folder's children, where they are excluded.
    pub(crate) fn open_folder_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        self.gallery
            .update(cx, |gallery, cx| gallery.stop_preview(cx));
        let excluded = self.current_preferences(cx).excluded_root_child_paths;
        let overlay = cx.new(|cx| FolderOverlay::new(root, excluded, window, cx));
        let subscription = cx.subscribe_in(&overlay, window, |this, _, event, window, cx| {
            match event {
                FolderOverlayEvent::Close => {}
                FolderOverlayEvent::Open(folder) => {
                    this.navigate_to_folder(folder.clone(), None, cx);
                }
                FolderOverlayEvent::ToggleExcluded(child) => {
                    let child = child.clone();
                    this.toggle_excluded_child(&child, cx);
                    return;
                }
            }
            this.folder_overlay = None;
            this.restore_focus(window, cx);
            cx.notify();
        });
        // Back to the button that opens it, whatever a click on that button left focused.
        self.focus_before_overlay = Some(self.folders_button.clone());
        overlay.focus_handle(cx).focus(window, cx);
        self.folder_overlay = Some((overlay, subscription));
        cx.notify();
    }
}

/// What a scan request leaves to the folder's preferences when it is `None`.
#[derive(Default)]
struct ScanOptions {
    recursive: Option<bool>,
    filters: Option<FileFilterSettings>,
    excluded: Option<Vec<String>>,
}

/// The clock in milliseconds mixed with a random number, as a `u32`.
fn random_seed() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(now);
    i64::from((now as u32) ^ (hasher.finish() as u32))
}

/// What takes the keys when View comes on screen with no focus of its own kept: the viewer, the
/// reader or the folder browser while one is open, else the gallery. Its keys, and the File
/// menu's Open Folder… and Refresh, then work at once.
impl gpui_kit::Focusable for ViewMode {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.overlay_focus(cx)
            .unwrap_or_else(|| self.gallery.focus_handle(cx))
    }
}

impl Render for ViewMode {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(spike) = &mut self.spike {
            spike.on_frame(&self.gallery, self.viewer.as_ref(), window, cx);
        }
        if let Some(ix) = self.pending_open_viewer.take() {
            self.open_viewer(ix, window, cx);
        }
        // File › Open Folder… (⌘O) and File › Refresh (⌘R), which the shell's menu sends to the
        // mode on screen, reach View under the viewer and the reader too.
        let commands = div()
            .size_full()
            .on_action(cx.listener(|this, _: &OpenFolder, _, cx| this.choose_folder(cx)))
            .on_action(cx.listener(|this, _: &Refresh, _, cx| this.refresh(cx)))
            // A folder, or a file whose folder opens, dropped anywhere on View: the gallery, the
            // sidebar, the top bar or the viewer.
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                if let Some(path) = paths.paths().first() {
                    this.open_path(path.clone(), window, cx);
                }
            }))
            // Escape closes the sort menu while it is open; the gallery's own keys have no Escape
            // for it to shadow.
            .when(self.sort_menu_open, |this| {
                this.on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape" {
                        this.sort_menu_open = false;
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
            });
        if let Some(viewer) = &self.viewer {
            return commands.child(viewer.clone()).into_any_element();
        }
        if let Some((reader, _)) = &self.comic_reader {
            return commands.child(reader.clone()).into_any_element();
        }

        let navigation = self.render_navigation(cx);
        let mut content = div()
            .id("view-content")
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(self.gallery.clone())
            // While the sort menu is open, a press anywhere but the toolbar closes it.
            .when(self.sort_menu_open, |content| {
                content.child(
                    div()
                        .id("sort-menu-backdrop")
                        .absolute()
                        .inset_0()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.sort_menu_open = false;
                                cx.notify();
                            }),
                        ),
                )
            })
            .child(self.render_toolbar(window, cx));
        if let Some((overlay, _)) = &self.folder_overlay {
            content = content.child(overlay.clone());
        }
        // Keys and the menu's View commands reach the gallery when nothing else has focus, as
        // after a launch.
        if window.focused(cx).is_none() {
            cx.defer_in(window, |this, window, cx| {
                if window.focused(cx).is_none() {
                    this.gallery.read(cx).focus_handle(cx).focus(window, cx);
                }
            });
        }
        commands
            .child(
                ModeLayout::new(&self.shell)
                    .navigation(navigation)
                    .child(self.render_top_bar(window, cx))
                    .child(content),
            )
            .into_any_element()
    }
}

impl Mode for ViewMode {
    const ID: ModeId = ModeId::View;

    fn commands() -> Vec<Command> {
        vec![
            Command::new(OpenFolder)
                .menu(MenuSlot::File, "Open Folder…")
                .keys(oriel_ui::cmd_or_ctrl!("o"))
                .sheet("Open a folder"),
            // F5 off macOS, as Electron Oriel's View had it.
            Command::new(Refresh)
                .menu(MenuSlot::File, "Refresh")
                .keys(if cfg!(target_os = "macos") {
                    "cmd-r"
                } else {
                    "f5"
                })
                .sheet("Refresh"),
        ]
    }

    fn sheet() -> Sheet {
        shortcuts::SHEET
    }

    fn folders(&self, _: &App) -> Vec<PathBuf> {
        self.opened_folder().into_iter().collect()
    }

    fn foot(&self, _: &App) -> Foot {
        Foot::height(px(FOOT_HEIGHT))
    }

    fn settings_section(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.render_settings_section(cx)
    }

    /// A file opens in the viewer once its folder lists, a folder as it is. A path no longer
    /// there is not shown, and a toast says so.
    fn show_hand_off(&mut self, target: HandOff, window: &mut Window, cx: &mut Context<Self>) {
        let path = target.path().to_path_buf();
        if !path.exists() {
            window.show_toast(
                Toast::error("View could not open it").detail(path.display().to_string()),
                cx,
            );
            return;
        }
        self.open_path(path, window, cx);
        self.shell
            .update(cx, |shell, cx| shell.go(ModeId::View, cx));
    }

    fn set_up(
        &mut self,
        set_up: &FolderSetUp,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), SharedString>> {
        self.open_folder(set_up.folder.clone(), cx);
        Task::ready(Ok(()))
    }
}
