//! A value read from the engine, as `useEngineQuery` keeps one: the last answer, or why there is
//! none, with only the newest request's answer kept, so a slow older one never overwrites it.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};

use gpui_kit::{AppContext, Context, SharedString, Task};

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

/// Waits for an engine call on GPUI's background executor, blocking one of its threads while the
/// catalog's thread answers. The answer then reaches the UI from GPUI's own executor, never from
/// the catalog's thread, which keeps headless tests deterministic (GPUI's test scheduler refuses
/// a wake from a thread it does not know).
pub fn engine_call<T: Send + 'static>(
    future: impl Future<Output = anyhow::Result<T>> + Send + 'static,
    cx: &impl AppContext,
) -> Task<anyhow::Result<T>> {
    cx.background_spawn(async move { futures::executor::block_on(future) })
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

    /// Asks again: `future`'s answer lands in the field `slot` names on the entity, unless a newer
    /// request was made meanwhile. The entity is notified when it lands.
    pub fn load<V: 'static>(
        &mut self,
        future: impl Future<Output = anyhow::Result<T>> + Send + 'static,
        slot: fn(&mut V) -> &mut Loaded<T>,
        cx: &mut Context<V>,
    ) {
        self.load_then(future, slot, |_, _| {}, cx);
    }

    /// [`Self::load`], then `then` once a newer request has not overtaken it.
    pub fn load_then<V: 'static>(
        &mut self,
        future: impl Future<Output = anyhow::Result<T>> + Send + 'static,
        slot: fn(&mut V) -> &mut Loaded<T>,
        then: fn(&mut V, &mut Context<V>),
        cx: &mut Context<V>,
    ) {
        self.stamp += 1;
        let stamp = self.stamp;
        let answer = engine_call(future, cx);
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
