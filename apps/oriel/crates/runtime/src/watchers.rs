//! A list of callbacks under a mutex, numbered so a guard can take its own back out. The
//! callbacks are copied or taken out before they run, so they never run under the lock, and a
//! panic in one cannot poison it; a poisoned lock still holds a consistent list.

use std::sync::{Mutex, MutexGuard, PoisonError};

pub(crate) struct Watchers<W> {
    list: Mutex<List<W>>,
}

pub(crate) struct List<W> {
    next_id: u64,
    entries: Vec<(u64, W)>,
}

impl<W> Default for Watchers<W> {
    fn default() -> Self {
        Self {
            list: Mutex::new(List {
                next_id: 0,
                entries: Vec::new(),
            }),
        }
    }
}

impl<W> Watchers<W> {
    /// The list, locked, for a caller that changes some state of its own under the same lock.
    pub(crate) fn lock(&self) -> MutexGuard<'_, List<W>> {
        self.list.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn remove(&self, id: u64) {
        self.lock().entries.retain(|(entry, _)| *entry != id);
    }
}

impl<W> List<W> {
    /// Adds `watcher`, returning the number its guard removes it by.
    pub(crate) fn add(&mut self, watcher: W) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push((id, watcher));
        id
    }

    /// Every watcher, taken out of the list, for callbacks that run once.
    pub(crate) fn take_all(&mut self) -> Vec<W> {
        std::mem::take(&mut self.entries)
            .into_iter()
            .map(|(_, watcher)| watcher)
            .collect()
    }
}

impl<W: Clone> List<W> {
    /// A copy of every watcher, to run outside the lock.
    pub(crate) fn snapshot(&self) -> Vec<W> {
        self.entries
            .iter()
            .map(|(_, watcher)| watcher.clone())
            .collect()
    }
}
