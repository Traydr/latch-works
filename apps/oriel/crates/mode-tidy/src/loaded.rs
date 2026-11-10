//! How Tidy's UI reaches the engine ([`TidyClient`]), and a value read from it ([`Loaded`]): the
//! last answer, or why there is none, with only the newest request's answer kept, so a slow older
//! one never overwrites it.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};

use gpui_kit::{AppContext, Context, SharedString, Task};
use oriel_core_tidy::contract::RootId;
use oriel_core_tidy::{Media, Queued, TidyEngine};

use crate::pages::TidyPage;
use crate::state::TidyState;

/// Page reads asked for whose answers have not landed yet, so the pages spike can tell when a
/// page has everything it asked for.
static READS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// How many page reads are still waiting for their answers.
pub fn reads_in_flight() -> usize {
    READS_IN_FLIGHT.load(Ordering::Relaxed)
}

/// Counts one page read from when it is asked for until its answer has landed, or the read is
/// dropped for a newer one.
pub struct InFlight(());

impl InFlight {
    pub fn start() -> Self {
        READS_IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        Self(())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        READS_IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The engine as Tidy's UI holds it. Its queries come back as GPUI tasks, waited for on GPUI's
/// background executor while the catalog's thread answers, so the answer reaches the UI from
/// GPUI's own executor and never from the catalog's thread: GPUI's test scheduler refuses a wake
/// from a thread it does not know. Its work comes back queued, for a job to run.
#[derive(Clone)]
pub struct TidyClient(TidyEngine);

impl TidyClient {
    pub(crate) fn new(engine: TidyEngine) -> Self {
        Self(engine)
    }

    /// The answer of `query`, which may ask the engine several things in turn.
    pub fn ask<T, F>(
        &self,
        query: impl FnOnce(TidyEngine) -> F,
        cx: &impl AppContext,
    ) -> Task<anyhow::Result<T>>
    where
        T: Send + 'static,
        F: Future<Output = anyhow::Result<T>> + Send + 'static,
    {
        let future = query(self.0.clone());
        cx.background_spawn(async move { futures::executor::block_on(future) })
    }

    /// Work the engine queues, for a job to run on a thread of its own.
    pub fn queue<T>(&self, work: impl FnOnce(&TidyEngine) -> Queued<T>) -> Queued<T> {
        work(&self.0)
    }

    /// See [`TidyEngine::check_root_removable`].
    pub fn check_root_removable(&self, root_id: RootId) -> anyhow::Result<()> {
        self.0.check_root_removable(root_id)
    }

    /// See [`TidyEngine::promote_analysis`].
    pub fn promote_analysis(&self, root_id: RootId) -> bool {
        self.0.promote_analysis(root_id)
    }

    pub fn media(&self) -> &Media {
        self.0.media()
    }
}

/// When a page reads from the engine: only while it is on screen, and again whenever the folder
/// on screen or the catalog has changed since it last read. Every page keeps one.
#[derive(Default)]
pub struct PageReads {
    seen: (Option<RootId>, u64),
}

/// What a page reads with, once it is due to read.
pub struct Read {
    pub engine: TidyClient,
    pub root_id: RootId,
    /// The folder on screen is another than at the last read, so what the page holds for the
    /// last one (a selection, how far it has paged) goes.
    pub root_changed: bool,
}

impl PageReads {
    /// Reads again at the next chance, as a page's Try again asks.
    pub fn forget(&mut self) {
        self.seen = (None, 0);
    }

    /// Whether `page` reads now; if so it counts as read. `None` while another page is on
    /// screen, nothing changed, or the engine has no folder to read yet.
    pub fn due(&mut self, page: TidyPage, state: &TidyState) -> Option<Read> {
        let key = (state.root_id(), state.catalog_version());
        if state.page() != page || key == self.seen {
            return None;
        }
        let root_changed = key.0 != self.seen.0;
        self.seen = key;
        Some(Read {
            engine: state.engine().cloned()?,
            root_id: state.root_id()?,
            root_changed,
        })
    }
}

pub struct Loaded<T> {
    data: Option<T>,
    error: Option<SharedString>,
    stamp: u64,
    task: Option<Task<()>>,
}

impl<T> Default for Loaded<T> {
    fn default() -> Self {
        Self {
            data: None,
            error: None,
            stamp: 0,
            task: None,
        }
    }
}

impl<T: Send + 'static> Loaded<T> {
    /// The last answer; kept while a newer request runs, so a page never blanks on refresh.
    pub fn data(&self) -> Option<&T> {
        self.data.as_ref()
    }

    /// Why the last request failed, when it did.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Forgets the answer, as a page does when what it shows changes root.
    pub fn clear(&mut self) {
        self.stamp += 1;
        self.data = None;
        self.error = None;
        self.task = None;
    }

    /// Asks again: `answer` lands in the field `slot` names on the entity, unless a newer
    /// request was made meanwhile. The entity is notified when it lands.
    pub fn load<V: 'static>(
        &mut self,
        answer: Task<anyhow::Result<T>>,
        slot: fn(&mut V) -> &mut Loaded<T>,
        cx: &mut Context<V>,
    ) {
        self.load_then(answer, slot, |_, _| {}, cx);
    }

    /// [`Self::load`], then `then` once a newer request has not overtaken it.
    pub fn load_then<V: 'static>(
        &mut self,
        answer: Task<anyhow::Result<T>>,
        slot: fn(&mut V) -> &mut Loaded<T>,
        then: fn(&mut V, &mut Context<V>),
        cx: &mut Context<V>,
    ) {
        self.stamp += 1;
        let stamp = self.stamp;
        let in_flight = InFlight::start();
        self.task = Some(cx.spawn(async move |this, cx| {
            let _in_flight = in_flight;
            let answer = answer.await;
            this.update(cx, |view, cx| {
                let loaded = slot(view);
                if loaded.stamp != stamp {
                    return;
                }
                match answer {
                    Ok(data) => {
                        loaded.data = Some(data);
                        loaded.error = None;
                    }
                    Err(error) => loaded.error = Some(format!("{error:#}").into()),
                }
                then(view, cx);
                cx.notify();
            })
            .ok();
        }));
    }
}
