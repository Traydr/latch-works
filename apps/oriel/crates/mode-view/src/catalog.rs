//! View's catalog: the scan of the folder on screen ([`scan`]), run on a background thread, and
//! what the gallery needs from it:
//!
//! - a new scan supersedes the one running, which is cancelled and whose results are dropped;
//! - its items arrive in batches while it runs, and are complete once it is done;
//! - each scan reads the folder's subfolders and its siblings again, so the sidebar, the folder
//!   tiles and the folder steps follow the disk.

mod scan;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui_kit::{AppContext as _, Context, EventEmitter, SharedString, Task};
use oriel_core_domain::format::plural;
use oriel_core_domain::{FolderNode, GallerySortMode};
use oriel_runtime::CancelToken;

pub use scan::{CatalogEvent, CatalogFilters, CatalogScan, list_folder_children};

use crate::listing::MediaEntry;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanState {
    Idle,
    Loading,
    Done,
    Error,
}

impl ScanState {
    /// The name Diagnostics shows.
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading => "loading",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

/// One scan asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanRequest {
    pub root: PathBuf,
    pub recursive: bool,
    pub filters: CatalogFilters,
    pub excluded_root_children: Vec<PathBuf>,
    /// The order the gallery shows, which the scan sorts its items in once it is done, off the
    /// main thread. The gallery sorts them itself if the order has changed meanwhile.
    pub order: SortOrder,
}

/// An order of the gallery: the sort mode, and the seed of the random one.
pub type SortOrder = (GallerySortMode, i64);

#[derive(Clone, Debug, PartialEq)]
pub enum CatalogUpdate {
    /// A scan started on its root: the gallery starts over.
    Reset,
    /// A scan finished.
    Done,
}

pub struct Catalog {
    /// The running scan's, while one runs.
    cancel: Option<CancelToken>,
    _scan: Option<Task<()>>,
    _folders: Option<Task<()>>,
    requested: Option<ScanRequest>,
    root: Option<Arc<Path>>,
    state: ScanState,
    message: SharedString,
    message_path: Option<SharedString>,
    /// Items found so far by the running scan, or all of the last one's, in the order found.
    items: Vec<MediaEntry>,
    /// The last scan's items in the order it was asked to sort them by, once it is done.
    sorted: Option<(SortOrder, Arc<[MediaEntry]>)>,
    /// Bumped whenever `items` changes, so the owner sorts only then.
    revision: u64,
    children: Arc<[FolderNode]>,
    siblings: Arc<[FolderNode]>,
    children_loading: bool,
}

impl EventEmitter<CatalogUpdate> for Catalog {}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            cancel: None,
            _scan: None,
            _folders: None,
            requested: None,
            root: None,
            state: ScanState::Idle,
            message: SharedString::default(),
            message_path: None,
            items: Vec::new(),
            sorted: None,
            revision: 0,
            children: Arc::from([]),
            siblings: Arc::from([]),
            children_loading: false,
        }
    }
}

impl Catalog {
    pub fn root(&self) -> Option<&Arc<Path>> {
        self.root.as_ref()
    }

    pub fn state(&self) -> ScanState {
        self.state
    }

    pub fn is_scanning(&self) -> bool {
        self.state == ScanState::Loading || self.cancel.is_some()
    }

    pub fn message(&self) -> &SharedString {
        &self.message
    }

    pub fn message_path(&self) -> Option<&SharedString> {
        self.message_path.as_ref()
    }

    pub fn items(&self) -> &[MediaEntry] {
        &self.items
    }

    /// The finished scan's items sorted by `order`, if the scan sorted them so.
    pub fn sorted(&self, order: SortOrder) -> Option<&Arc<[MediaEntry]>> {
        self.sorted
            .as_ref()
            .filter(|(sorted_by, _)| *sorted_by == order)
            .map(|(_, sorted)| sorted)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn requested(&self) -> Option<&ScanRequest> {
        self.requested.as_ref()
    }

    /// The folder's subfolders, by name at base strength.
    pub fn children(&self) -> &Arc<[FolderNode]> {
        &self.children
    }

    pub fn children_loading(&self) -> bool {
        self.children_loading
    }

    /// The folder's siblings, its parent's subfolders, for the folder steps.
    pub fn siblings(&self) -> &Arc<[FolderNode]> {
        &self.siblings
    }

    /// Starts a scan, cancelling the one running. The old scan's events stop with its task,
    /// which this replaces, so none of them arrive after.
    pub fn scan(&mut self, request: ScanRequest, cx: &mut Context<Self>) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
            self.message = "Scanning folder...".into();
            self.message_path = None;
        }
        self.state = ScanState::Loading;
        let cancel = CancelToken::new();
        self.cancel = Some(cancel.clone());
        let scan = CatalogScan::new(&request);
        let order = request.order;
        self.requested = Some(request);

        let (sender, mut receiver) = mpsc::unbounded();
        let worker = cx.background_spawn(async move {
            scan.run(&cancel, &mut |event| {
                let _ = sender.unbounded_send(event);
            });
        });
        self._scan = Some(cx.spawn(async move |this, cx| {
            while let Some(first) = receiver.next().await {
                // Take whatever else has arrived too, so a burst of batches draws once.
                let mut events = vec![first];
                while let Ok(event) = receiver.try_recv() {
                    events.push(event);
                }
                let applied = this.update(cx, |this, cx| {
                    for event in events {
                        this.apply(event, order, cx);
                    }
                    cx.notify();
                });
                if applied.is_err() {
                    break;
                }
            }
            worker.await;
        }));
        cx.notify();
    }

    fn apply(&mut self, event: CatalogEvent, order: SortOrder, cx: &mut Context<Self>) {
        match event {
            CatalogEvent::Reset { root_path } => {
                let root: Arc<Path> = PathBuf::from(root_path).into();
                self.read_folders(&root, cx);
                self.root = Some(root);
                self.items.clear();
                self.sorted = None;
                self.revision += 1;
                self.state = ScanState::Loading;
                self.message = "Scanning folder...".into();
                self.message_path = None;
                cx.emit(CatalogUpdate::Reset);
            }
            CatalogEvent::Progress { current_path, .. } => {
                self.state = ScanState::Loading;
                self.message = "Scanning".into();
                self.message_path = Some(current_path.into());
            }
            CatalogEvent::Batch(items) => {
                self.items.extend(items);
                self.sorted = None;
                self.revision += 1;
            }
            CatalogEvent::Done { sorted, elapsed } => {
                self.cancel = None;
                self.state = ScanState::Done;
                self.message = format!(
                    "Loaded {} in {:.1}s",
                    plural(sorted.len(), "item"),
                    elapsed.as_secs_f64()
                )
                .into();
                self.message_path = None;
                self.sorted = Some((order, sorted));
                self.revision += 1;
                cx.emit(CatalogUpdate::Done);
            }
            CatalogEvent::Cancelled => {
                self.cancel = None;
                self.state = ScanState::Idle;
                self.message = "Scan cancelled".into();
                self.message_path = None;
                self.revision += 1;
            }
            // An error of the running scan is reported while it goes on.
            CatalogEvent::Error { message, path } => {
                self.state = ScanState::Loading;
                self.message = message.into();
                self.message_path = Some(path.into());
            }
        }
    }

    /// Reports a scan that could not start, such as a folder that is not there.
    pub fn fail(
        &mut self,
        message: impl Into<SharedString>,
        path: Option<&Path>,
        cx: &mut Context<Self>,
    ) {
        self.state = ScanState::Error;
        self.message = message.into();
        self.message_path = path.map(|path| path.to_string_lossy().into_owned().into());
        cx.notify();
    }

    /// Reads the folder's subfolders and its parent's, on the background executor. A folder that
    /// cannot be read is reported as the scan's errors are, and lists no subfolders.
    fn read_folders(&mut self, root: &Arc<Path>, cx: &mut Context<Self>) {
        self.children_loading = true;
        let root = root.clone();
        self._folders = Some(cx.spawn(async move |this, cx| {
            let folder = root.clone();
            let (children, siblings) = cx
                .background_spawn(async move {
                    let children = (list_folder_children(&folder), folder.to_path_buf());
                    let siblings = folder
                        .parent()
                        .map(|parent| (list_folder_children(parent), parent.to_path_buf()));
                    (children, siblings)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.root.as_ref() != Some(&root) {
                    return;
                }
                this.children = this.listed(children).into();
                this.siblings = siblings
                    .map(|read| this.listed(read))
                    .unwrap_or_default()
                    .into();
                this.children_loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    fn listed(
        &mut self,
        (read, folder): (std::io::Result<Vec<FolderNode>>, PathBuf),
    ) -> Vec<FolderNode> {
        read.unwrap_or_else(|error| {
            log::warn!("cannot list the folders in {}: {error}", folder.display());
            self.message = format!("Unable to list subfolders: {error}").into();
            self.message_path = Some(folder.to_string_lossy().into_owned().into());
            Vec::new()
        })
    }
}
