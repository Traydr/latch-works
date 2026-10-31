//! View: a folder's media as a gallery, the viewer, the capsule player and the comic reader, as
//! Electron Oriel's View mode had them.
//!
//! View reads; it never writes inside a folder it shows. What it keeps goes under
//! `DataRoot::view()`, laid out as Electron Oriel lays out its View folder: the settings file
//! (`frame-view-settings.json`), the media index (`media-index.sqlite`) and the thumbnails
//! (`frame-view/thumbnails`).
//!
//! [`ViewMode`] holds the session: the folder on screen and the one the owner opened (above
//! which View does not step), whether the listing is recursive, and the overlays. The scan is
//! [`catalog::Catalog`]'s, the grid [`Gallery`]'s, and the rules (order, comics, the gallery's
//! entries) `oriel-core-domain`'s.

pub mod browser;
pub mod catalog;
mod comic_reader;
pub mod folder_overlay;
pub mod gallery;
mod header;
pub mod listing;
pub mod media_tools;
mod player;
pub mod settings;
mod settings_section;
mod sidebar;
mod spike;
pub mod thumbnails;
mod toolbar;
pub mod viewer;

pub use comic_reader::{ComicReader, ComicReaderEvent};
pub use folder_overlay::{FolderOverlay, FolderOverlayEvent};
pub use gallery::{Activation, FolderStep, Gallery, GalleryEvent, Listing, PreviewSettings};
pub use player::{CapsulePanel, CapsulePlayer, CapsulePlayerEvent, PlayerOptions};
pub use settings_section::{Diagnostics, FactGroup, LineGroup};
pub use viewer::{Viewer, ViewerEvent};

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher as _, Hasher as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, ExternalPaths, FocusHandle,
    Focusable as _, Global, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    ParentElement as _, PathPromptOptions, Render, SharedString, Styled as _, Subscription, Task,
    Window, div, prelude::FluentBuilder as _,
};
use oriel_core_domain::GallerySortMode;
use oriel_core_paths::DataRoot;
use oriel_ui::{ActivityJob, ModeActivity, ModeId, ModeLayout, ShellState, commands};

use crate::browser::{Browse, Comic, Tile, build_comics, build_tiles, sort_media};
use crate::catalog::{Catalog, CatalogUpdate, ScanRequest, ScanState};
use crate::gallery::metrics::TileAspect;
use crate::listing::{MediaEntry, resolve_folder_path, scan_filters};
use crate::settings::{FileFilterSettings, SettingsStore, ViewSettings};

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
    gallery::bind_keys(cx);
    comic_reader::bind_keys(cx);
    folder_overlay::bind_keys(cx);
}

/// What View asks of the rest of the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ViewEvent {
    /// The viewer's Show in Tidy, for this file: the app shows it in Tidy, as Electron Oriel's
    /// `handOff("tidy", { kind: "file", path })` does. View stays as it is underneath.
    ShowInTidy(PathBuf),
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
    settings: SettingsStore,
    catalog: Entity<Catalog>,
    gallery: Entity<Gallery>,
    viewer: Option<Entity<Viewer>>,
    /// The open viewer's close event, dropped with it.
    viewer_subscription: Option<Subscription>,
    /// Where focus was before an overlay took it, to give it back on close.
    focus_before_overlay: Option<FocusHandle>,
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
    /// The ready status's timer, which redraws the header when it lapses.
    _status_timer: Option<Task<()>>,
    pub(crate) settings_panel: settings_section::SettingsPanel,
    pub(crate) spike: Option<spike::Spike>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ViewEvent> for ViewMode {}

impl ViewMode {
    /// View for the shell, keeping its data in this run's data folder. Opens the folder
    /// [`OPEN_VARIABLE`] names, if it names one, and the remembered folder otherwise.
    pub fn new(shell: &Entity<ShellState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let data = DataRoot::from_environment().expect("Oriel RS needs a data folder");
        let launch = std::env::var_os(OPEN_VARIABLE)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let mut view = Self::create(shell, &data, launch.is_none(), window, cx);
        view.spike = spike::Spike::from_environment(window, cx);
        // The measurements list a whole fixture, as Phase 0's listing did.
        view.recursive |= view.spike.is_some();
        if let Some(folder) = launch {
            view.open_path(folder, window, cx);
        }
        view
    }

    /// View keeping its data under `data`, opening the remembered folder if there is one.
    pub fn with_data(
        shell: &Entity<ShellState>,
        data: &DataRoot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::create(shell, data, true, window, cx)
    }

    fn create(
        shell: &Entity<ShellState>,
        data: &DataRoot,
        restore: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        init(cx);
        let folder = data.view();
        let settings = SettingsStore::load(&folder);
        let thumbnails = thumbnails::THUMBNAIL_FOLDER
            .iter()
            .fold(folder.clone(), |path, part| path.join(part));
        let gallery = cx.new(|cx| Gallery::new(shell, thumbnails, cx));
        let catalog = cx.new(|_| Catalog::new(folder));
        let subscriptions = vec![
            cx.observe(shell, |this, shell, cx| {
                // Another mode on screen: a hover preview has no pointer left to stop it.
                if shell.read(cx).mode() != ModeId::View {
                    this.gallery
                        .update(cx, |gallery, cx| gallery.stop_preview(cx));
                }
                cx.notify();
            }),
            // Back on screen with the viewer or the reader open, View gives it the keys again,
            // so Escape and the arrows reach it: another mode may have taken them meanwhile.
            // Leaving the screen, it pauses the viewer's video, as Electron Oriel pauses a
            // hidden mode's media, and their chrome stops fading, which would hide the pointer
            // over the mode or the Settings page on screen.
            cx.observe_in(shell, window, {
                let on_screen =
                    |shell: &ShellState| shell.mode() == ModeId::View && shell.settings().is_none();
                let mut shown = on_screen(shell.read(cx));
                move |this, shell, window, cx| {
                    let now = on_screen(shell.read(cx));
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
            settings,
            catalog,
            gallery,
            viewer: None,
            viewer_subscription: None,
            focus_before_overlay: None,
            comic_reader: None,
            folder_overlay: None,
            sort_menu_open: false,
            recursive: false,
            navigation_ceiling: None,
            pending_selection: None,
            pending_focus: None,
            pending_open_viewer: None,
            thumbnails_root: None,
            sorted: SortedMedia::default(),
            _status_timer: None,
            settings_panel: settings_section::SettingsPanel::new(window, cx),
            spike: None,
            _subscriptions: subscriptions,
        };
        view._subscriptions.push(thumbnail_observer);
        view.settings_panel
            .sync(view.settings.settings(), window, cx);
        view.apply_display_settings(cx);
        if restore {
            view.restore_last_folder(cx);
        }
        view
    }

    pub fn gallery(&self) -> &Entity<Gallery> {
        &self.gallery
    }

    /// Gives the keys to the overlay on top (the viewer, the comic reader or the folder
    /// overlay), if one is open and does not have them.
    fn focus_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focus = if let Some(viewer) = &self.viewer {
            viewer.focus_handle(cx)
        } else if let Some((reader, _)) = &self.comic_reader {
            reader.focus_handle(cx)
        } else if let Some((overlay, _)) = &self.folder_overlay {
            overlay.focus_handle(cx)
        } else {
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

    /// Where View keeps its settings.
    pub fn settings_path(&self) -> &Path {
        self.settings.path()
    }

    /// The session's recursive switch, with the folder's comic mode applied
    /// (`effectiveRecursive`).
    pub fn is_recursive(&self, cx: &App) -> bool {
        self.recursive || self.comic_mode(cx)
    }

    /// Whether the folder on screen is in comic mode.
    pub fn comic_mode(&self, cx: &App) -> bool {
        self.current_preferences(cx).comic_mode
    }

    /// The folder on screen.
    pub fn folder(&self, cx: &App) -> Option<Arc<Path>> {
        self.catalog.read(cx).root().cloned()
    }

    /// The folder View works on, as the other modes are offered it (`openedFolder`): the one the
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
        let root = self
            .catalog
            .read(cx)
            .root()
            .map(|root| root.to_string_lossy().into_owned());
        self.settings.settings().root_preferences(root.as_deref())
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

    /// `startScanAtPath`, after the dialog's grant: the folder is the new top and the remembered
    /// folder.
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

    /// `useAppBootstrap`'s start: back where the owner left off, with the folder they opened
    /// still the top when the last folder is inside it.
    fn restore_last_folder(&mut self, cx: &mut Context<Self>) {
        let settings = self.settings.settings().clone();
        let Some(last) = settings
            .last_folder_path
            .clone()
            .filter(|_| settings.remember_last_folder)
        else {
            return;
        };
        let last = PathBuf::from(last);
        let ceiling = settings
            .last_opened_folder_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|opened| last.starts_with(opened))
            .unwrap_or_else(|| last.clone());
        self.navigation_ceiling = Some(ceiling.into());
        let preferences = settings.root_preferences(Some(&last.to_string_lossy()));
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

    /// `runScan`: options left out come from the scanned folder's own preferences.
    fn run_scan(&mut self, folder: &Path, options: ScanOptions, cx: &mut Context<Self>) {
        let settings = self.settings.settings();
        let folder_text = folder.to_string_lossy().into_owned();
        let preferences = settings.root_preferences(Some(&folder_text));
        let recursive = options
            .recursive
            .unwrap_or(self.recursive || preferences.comic_mode);
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
                // The ready status lapses after a while; redraw the header then.
                self._status_timer = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(catalog::READY_STATUS_FOR)
                        .await;
                    this.update(cx, |_, cx| cx.notify()).ok();
                }));
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
        let board = self.shell.read(cx).jobs().clone();
        self.shell.update(cx, |shell, cx| {
            shell.set_activity(ModeId::View, activity, cx);
        });
        board.update(cx, |board, cx| board.set_jobs(ModeId::View, jobs, cx));
    }

    /// The gallery's tiles for the catalog and settings as they are: `buildBrowserEntryCollection`
    /// over the sorted items, or over the items found so far while a scan runs.
    fn rebuild_tiles(&mut self, cx: &mut Context<Self>) {
        let catalog = self.catalog.read(cx);
        let settings = self.settings.settings();
        let root = catalog
            .root()
            .map(|root| root.to_string_lossy().into_owned());
        let preferences = settings.root_preferences(root.as_deref());
        let comic_mode = preferences.comic_mode;
        let recursive = self.recursive || comic_mode;
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
            None => "Drop a folder or click Open below".into(),
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
        }
    }

    /// `navigateToFolderAction`: another folder inside the opened one; the top stays.
    pub(crate) fn navigate_to_folder(
        &mut self,
        folder: PathBuf,
        select_after: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.pending_selection = select_after;
        self.run_scan(&folder, ScanOptions::default(), cx);
    }

    /// The folder above the one on screen, while it is inside the opened one.
    pub(crate) fn parent_folder(&self, cx: &App) -> Option<PathBuf> {
        let root = self.catalog.read(cx).root()?;
        let parent = root.parent()?;
        let ceiling = self.navigation_ceiling.as_ref()?;
        let fold = |path: &Path| path.to_string_lossy().to_lowercase();
        let (parent_text, ceiling_text) = (fold(parent), fold(ceiling));
        (parent_text == ceiling_text || parent_text.starts_with(&format!("{ceiling_text}/")))
            .then(|| parent.to_path_buf())
    }

    pub(crate) fn open_parent_folder(&mut self, cx: &mut Context<Self>) {
        let Some(parent) = self.parent_folder(cx) else {
            return;
        };
        let current = self
            .catalog
            .read(cx)
            .root()
            .map(|root| SharedString::from(format!("folder:{}", root.display())));
        self.navigate_to_folder(parent, current, cx);
    }

    /// The previous (`-1`) or next (`1`) sibling, unless the folder on screen is the top.
    pub(crate) fn sibling_folder(&self, direction: isize, cx: &App) -> Option<PathBuf> {
        let catalog = self.catalog.read(cx);
        let root = catalog.root()?;
        if self.navigation_ceiling.as_ref().is_some_and(|ceiling| {
            ceiling.to_string_lossy().to_lowercase() == root.to_string_lossy().to_lowercase()
        }) {
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

    /// `onToggleRecursive`: per session. Turning it off turns the folder's comic mode off too.
    pub(crate) fn set_recursive(&mut self, recursive: bool, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        self.recursive = recursive;
        let preferences = self.current_preferences(cx);
        if !recursive && preferences.comic_mode {
            let key = root.to_string_lossy().into_owned();
            self.update_settings(cx, |settings| {
                let mut preferences = settings.root_preferences(Some(&key));
                preferences.comic_mode = false;
                settings.set_root_preferences(&key, preferences);
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

    /// `onToggleComicMode`: comic on forces recursive on, comic off turns it back off.
    pub(crate) fn set_comic_mode(&mut self, comic_mode: bool, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        let key = root.to_string_lossy().into_owned();
        self.update_settings(cx, |settings| {
            let mut preferences = settings.root_preferences(Some(&key));
            preferences.comic_mode = comic_mode;
            settings.set_root_preferences(&key, preferences);
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

    /// `onToggleExcludedRootChild`: saved for the opened folder, and the latest recursive scan of
    /// it repeated without the excluded children.
    pub(crate) fn toggle_excluded_child(&mut self, child: &Path, cx: &mut Context<Self>) {
        let Some(root) = self.catalog.read(cx).root().cloned() else {
            return;
        };
        let key = root.to_string_lossy().into_owned();
        let child = child.to_string_lossy().into_owned();
        self.update_settings(cx, |settings| {
            let mut preferences = settings.root_preferences(Some(&key));
            preferences.toggle_excluded(&child);
            settings.set_root_preferences(&key, preferences);
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

    /// Shuffle: a new random order (`createRandomSeed`), never the one on screen.
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
            ViewerEvent::ShowInTidy(path) => cx.emit(ViewEvent::ShowInTidy(path.clone())),
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
        if self.focus_before_overlay.is_none() {
            self.focus_before_overlay = window.focused(cx);
        }
        overlay.focus_handle(cx).focus(window, cx);
        self.folder_overlay = Some((overlay, subscription));
        cx.notify();
    }

    /// This mode's section of the one Settings page (⌘,). The shell draws the page and calls this
    /// for the mode's section; the mode owns what is in it.
    pub fn settings_section(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.render_settings_section(window, cx)
    }
}

/// What a scan request leaves to the folder's preferences when it is `None`.
#[derive(Default)]
struct ScanOptions {
    recursive: Option<bool>,
    filters: Option<FileFilterSettings>,
    excluded: Option<Vec<String>>,
}

/// `createRandomSeed`: the clock in milliseconds mixed with a random number, as a `u32`.
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
        if let Some(viewer) = &self.viewer {
            viewer.focus_handle(cx)
        } else if let Some((reader, _)) = &self.comic_reader {
            reader.focus_handle(cx)
        } else if let Some((overlay, _)) = &self.folder_overlay {
            overlay.focus_handle(cx)
        } else {
            self.gallery.focus_handle(cx)
        }
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
        // mode on screen, reach View under the viewer and the reader too, as in Electron Oriel.
        let commands = div()
            .size_full()
            .on_action(cx.listener(|this, _: &commands::OpenFolder, _, cx| this.choose_folder(cx)))
            .on_action(cx.listener(|this, _: &commands::Refresh, _, cx| this.refresh(cx)))
            // A folder, or a file whose folder opens, dropped anywhere on View: the gallery, the
            // sidebar, the top bar or the viewer (`useAppBootstrap` listens on the window).
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                if let Some(path) = paths.paths().first() {
                    this.open_path(path.clone(), window, cx);
                }
            }))
            // Escape closes the sort menu, as `GalleryToolbar` listens for it while the menu is
            // open; the gallery's own keys have no Escape for it to shadow.
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
            // While the sort menu is open, a press anywhere but the toolbar closes it, as
            // `GalleryToolbar` listens for one.
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
            .child(self.render_toolbar(cx));
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
                    .child(self.render_top_bar(cx))
                    .child(content),
            )
            .into_any_element()
    }
}
