//! View's catalog: the scan of the folder on screen, run on a background thread through
//! `oriel-core-index`, and what the gallery needs from it, as Electron Oriel's catalog worker,
//! `ScanQueue` and `scanState.ts` keep it:
//!
//! - a new scan supersedes the one running, which is cancelled and whose results are dropped;
//! - its items arrive in batches while it runs, and are complete once it is done;
//! - each scan reads the folder's subfolders and its siblings again, so the sidebar, the folder
//!   tiles and the folder steps follow the disk;
//! - the media index records each scan, opened on first use, in `DataRoot::view()`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use futures::channel::mpsc;
use futures::executor::block_on;
use gpui_kit::{AppContext as _, Context, EventEmitter, SharedString, Task};
use oriel_core_domain::FolderNode;
use oriel_core_index::{
    CatalogEvent, CatalogFilters, CatalogScan, MediaIndex, MediaIndexStats, list_folder_children,
};
use oriel_runtime::CancelToken;

use crate::listing::MediaEntry;

/// How long "Loaded N item(s)" stays in the header after a scan (`PrismLayout`'s ready state).
pub const READY_STATUS_FOR: Duration = Duration::from_secs(5);

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

/// One scan asked for: `ScanOptions`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanRequest {
    pub root: PathBuf,
    pub recursive: bool,
    pub filters: CatalogFilters,
    pub excluded_root_children: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CatalogUpdate {
    /// A scan started on its root: the gallery starts over.
    Reset,
    /// A scan finished.
    Done,
}

/// The media index, opened on the background thread that first needs it.
#[derive(Clone)]
pub struct IndexHandle {
    folder: Arc<Path>,
    index: Arc<Mutex<Option<Result<MediaIndex, String>>>>,
}

impl IndexHandle {
    pub fn new(folder: impl Into<PathBuf>) -> Self {
        Self {
            folder: folder.into().into(),
            index: Arc::default(),
        }
    }

    /// The index, opened now if it is not yet. Blocks; call it on a background thread.
    pub fn get(&self) -> Option<MediaIndex> {
        let mut index = self.index.lock().unwrap_or_else(PoisonError::into_inner);
        let opened = index.get_or_insert_with(|| {
            block_on(MediaIndex::open_in(&self.folder)).map_err(|error| {
                log::warn!("View's media index cannot be opened: {error:#}");
                format!("{error:#}")
            })
        });
        opened.as_ref().ok().cloned()
    }

    pub fn stats(&self) -> Option<MediaIndexStats> {
        block_on(self.get()?.stats()).ok()
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        match self.get() {
            Some(index) => block_on(index.clear()),
            None => Ok(()),
        }
    }
}

pub struct Catalog {
    index: IndexHandle,
    next_run: u64,
    active_run: Option<u64>,
    cancel: Option<CancelToken>,
    _scan: Option<Task<()>>,
    _folders: Option<Task<()>>,
    requested: Option<ScanRequest>,
    root: Option<Arc<Path>>,
    recursive: bool,
    state: ScanState,
    message: SharedString,
    message_path: Option<SharedString>,
    /// Items found so far by the running scan, or all of the last one's, in the order found.
    items: Vec<MediaEntry>,
    /// Bumped whenever `items` changes, so the owner sorts only then.
    revision: u64,
    children: Arc<[FolderNode]>,
    siblings: Arc<[FolderNode]>,
    children_loading: bool,
    finished_at: Option<Instant>,
}

impl EventEmitter<CatalogUpdate> for Catalog {}

impl Catalog {
    /// A catalog keeping its index in `view_folder`.
    pub fn new(view_folder: impl Into<PathBuf>) -> Self {
        Self {
            index: IndexHandle::new(view_folder),
            next_run: 1,
            active_run: None,
            cancel: None,
            _scan: None,
            _folders: None,
            requested: None,
            root: None,
            recursive: false,
            state: ScanState::Idle,
            message: SharedString::default(),
            message_path: None,
            items: Vec::new(),
            revision: 0,
            children: Arc::from([]),
            siblings: Arc::from([]),
            children_loading: false,
            finished_at: None,
        }
    }

    pub fn index(&self) -> &IndexHandle {
        &self.index
    }

    pub fn root(&self) -> Option<&Arc<Path>> {
        self.root.as_ref()
    }

    pub fn recursive(&self) -> bool {
        self.recursive
    }

    pub fn state(&self) -> ScanState {
        self.state
    }

    pub fn is_scanning(&self) -> bool {
        self.state == ScanState::Loading || self.active_run.is_some()
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

    /// When the last scan finished, for the header's ready status.
    pub fn finished_at(&self) -> Option<Instant> {
        self.finished_at
    }

    /// Starts a scan, cancelling the one running: `createSupersedeActiveScan`, then the worker's
    /// `startScan`.
    pub fn scan(&mut self, request: ScanRequest, cx: &mut Context<Self>) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if self.active_run.take().is_some() {
            self.message = "Scanning folder...".into();
            self.message_path = None;
        }
        let run_id = self.next_run;
        self.next_run += 1;
        self.active_run = Some(run_id);
        self.state = ScanState::Loading;
        self.requested = Some(request.clone());
        let cancel = CancelToken::new();
        self.cancel = Some(cancel.clone());

        let scan = CatalogScan::new(
            run_id,
            request.root.clone(),
            request.recursive,
            request.filters.clone(),
        )
        .excluding(request.excluded_root_children.clone());
        let index = self.index.clone();
        let (sender, mut receiver) = mpsc::unbounded();
        let worker = cx.background_spawn(async move {
            scan.run(index.get().as_ref(), &cancel, &mut |event| {
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
                        this.apply(event, cx);
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

    /// `createApplyScanEvent`: events of a run other than the newest are dropped.
    fn apply(&mut self, event: CatalogEvent, cx: &mut Context<Self>) {
        match event {
            CatalogEvent::Reset {
                run_id,
                root_path,
                recursive,
            } => {
                if self.active_run != Some(run_id) {
                    return;
                }
                let root: Arc<Path> = PathBuf::from(root_path).into();
                self.read_folders(&root, cx);
                self.root = Some(root);
                self.recursive = recursive;
                self.items.clear();
                self.revision += 1;
                self.state = ScanState::Loading;
                self.message = "Scanning folder...".into();
                self.message_path = None;
                self.finished_at = None;
                cx.emit(CatalogUpdate::Reset);
            }
            CatalogEvent::Progress {
                run_id,
                current_path,
                ..
            } => {
                if self.active_run == Some(run_id) {
                    self.state = ScanState::Loading;
                    self.message = "Scanning".into();
                    self.message_path = Some(current_path.into());
                }
            }
            CatalogEvent::Batch { run_id, items } => {
                if self.active_run == Some(run_id) {
                    self.items
                        .extend(items.iter().map(MediaEntry::from_catalog));
                    self.revision += 1;
                }
            }
            CatalogEvent::Done {
                run_id,
                total_items,
                elapsed,
            } => {
                if self.active_run != Some(run_id) {
                    return;
                }
                self.active_run = None;
                self.cancel = None;
                self.state = ScanState::Done;
                self.message = format!(
                    "Loaded {total_items} item(s) in {:.1}s",
                    elapsed.as_secs_f64()
                )
                .into();
                self.message_path = None;
                self.finished_at = Some(Instant::now());
                self.revision += 1;
                cx.emit(CatalogUpdate::Done);
            }
            CatalogEvent::Cancelled { run_id } => {
                if self.active_run != Some(run_id) {
                    return;
                }
                self.active_run = None;
                self.cancel = None;
                self.state = ScanState::Idle;
                self.message = "Scan cancelled".into();
                self.message_path = None;
                self.revision += 1;
            }
            CatalogEvent::Error {
                run_id,
                message,
                path,
            } => {
                if run_id.is_some() && run_id != self.active_run {
                    return;
                }
                // An error of the running scan is reported while it goes on.
                self.state = if run_id.is_some() {
                    ScanState::Loading
                } else {
                    ScanState::Error
                };
                self.message = message.into();
                self.message_path = path.map(Into::into);
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

    /// Reads the folder's subfolders and its parent's, on the background executor.
    fn read_folders(&mut self, root: &Arc<Path>, cx: &mut Context<Self>) {
        self.children_loading = true;
        let root = root.clone();
        self._folders = Some(cx.spawn(async move |this, cx| {
            let folder = root.clone();
            let (children, siblings) = cx
                .background_spawn(async move {
                    let children = list_folder_children(&folder).unwrap_or_default();
                    let siblings = folder
                        .parent()
                        .and_then(|parent| list_folder_children(parent).ok())
                        .unwrap_or_default();
                    (children, siblings)
                })
                .await;
            this.update(cx, |this, cx| {
                if this.root.as_ref() == Some(&root) {
                    this.children = children.into();
                    this.siblings = siblings.into();
                    this.children_loading = false;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// Stops the running scan, if any, as View's teardown does.
    pub fn cancel(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
    }
}
