//! Whose turn it is, after glazier-core's `engine/jobs.ts` queue: one piece of work runs at a time,
//! so a scan and a change never touch a root together.
//!
//! - Work the owner asked for (a scan, a change, "Check now") runs in the order it was asked for,
//!   ahead of every waiting piece of background analysis.
//! - Background analysis that is running when asked-for work arrives steps aside at its next
//!   checkpoint, once its items in flight have finished, and carries on when no asked-for work
//!   waits, before any other background analysis.
//! - A paused piece of work keeps its turn, so a paused change holds what waits behind it, as in
//!   Electron Oriel; paused background analysis still steps aside for asked-for work.
//!
//! Each piece of work holds a [`Turn`] while it runs, and does its work through the turn, which is
//! a [`Progress`] whose checkpoint waits as above. The work runs on threads of its own, so waiting
//! blocks: on one condition variable, which the queue, the pause token and the cancel token all
//! wake.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use oriel_runtime::{CancelCallback, CancelToken, Cancelled, PauseCallback, PauseToken};

use crate::contract::RootId;
use crate::passes::Progress;

/// Which work goes first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    /// Work the owner asked for: scans, changes, and analysis they started.
    AskedFor,
    /// Analysis nobody asked for just now, which runs only while no asked-for work waits.
    Background,
}

/// A piece of work's place: waiting for its turn, holding it, or stepped aside.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    Waiting,
    Running,
    SteppedAside,
}

struct Entry {
    id: u64,
    /// Shared with the turn, so promoting background work reaches it while it runs.
    background: Arc<AtomicBool>,
    roots: Vec<RootId>,
    cancel: Option<CancelToken>,
    place: Place,
}

impl Entry {
    fn is_background(&self) -> bool {
        self.background.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct Queue {
    next_id: u64,
    /// In the order the work arrived.
    entries: Vec<Entry>,
}

impl Queue {
    fn entry(&self, id: u64) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn entry_mut(&mut self, id: u64) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.id == id)
    }

    fn asked_for_waiting(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.place == Place::Waiting && !entry.is_background())
            .count()
    }

    /// Whether `id` may take the turn now.
    fn may_run(&self, id: u64) -> bool {
        if self
            .entries
            .iter()
            .any(|entry| entry.place == Place::Running)
        {
            return false;
        }
        let Some(entry) = self.entry(id) else {
            return false;
        };
        if !entry.is_background() {
            return self
                .entries
                .iter()
                .find(|entry| entry.place == Place::Waiting && !entry.is_background())
                .is_some_and(|first| first.id == id);
        }
        if self.asked_for_waiting() > 0 {
            return false;
        }
        // Background work that stepped aside goes on before any that has not started.
        let next = self
            .entries
            .iter()
            .find(|entry| entry.place == Place::SteppedAside)
            .or_else(|| {
                self.entries
                    .iter()
                    .find(|entry| entry.place == Place::Waiting)
            });
        next.is_some_and(|next| next.id == id)
    }
}

#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    /// Asked-for work waiting for its turn, read without the lock by background work between
    /// items; kept in step with the queue under its lock.
    asked_for_waiting: AtomicUsize,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Publishes what changed in the queue and wakes every waiter to look again.
    fn changed(&self, queue: &Queue) {
        self.asked_for_waiting
            .store(queue.asked_for_waiting(), Ordering::Release);
        self.wake.notify_all();
    }

    fn wait<'a>(&self, queue: MutexGuard<'a, Queue>) -> MutexGuard<'a, Queue> {
        self.wake
            .wait(queue)
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Wakes the waiters from outside, for a pause or a cancel. Taking the lock first means a
    /// waiter that checked before the change is already waiting, so it cannot miss the wake.
    fn nudge(&self) {
        let _queue = self.lock();
        self.wake.notify_all();
    }
}

/// The engine's queue of work. Clones share it.
#[derive(Clone, Default)]
pub(crate) struct Scheduler {
    shared: Arc<Shared>,
}

/// Why a root cannot be removed now.
#[derive(Debug)]
pub(crate) struct RootBusy;

impl std::fmt::Display for RootBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Wait for this root's jobs to finish before removing it.")
    }
}

impl std::error::Error for RootBusy {}

impl Scheduler {
    /// Queues work on `roots` and waits for its turn, saying it waits through `progress` while it
    /// does. Fails at once, or while it waits, when the work is cancelled.
    pub(crate) fn take_turn<'a>(
        &'a self,
        priority: Priority,
        roots: Vec<RootId>,
        progress: &'a dyn Progress,
    ) -> Result<Turn<'a>, Cancelled> {
        progress.check()?;
        let background = Arc::new(AtomicBool::new(priority == Priority::Background));
        // Registered before the lock is taken: a callback on a token cancelled already runs at
        // once, and takes the lock itself.
        let wakers = self.wakers(progress);
        let id = {
            let mut queue = self.shared.lock();
            let id = queue.next_id;
            queue.next_id += 1;
            queue.entries.push(Entry {
                id,
                background: background.clone(),
                roots,
                cancel: progress.cancel_token().cloned(),
                place: Place::Waiting,
            });
            self.shared.changed(&queue);
            id
        };
        let turn = Turn {
            shared: &self.shared,
            id,
            background,
            reported_background: AtomicBool::new(priority == Priority::Background),
            progress,
            _wakers: wakers,
        };
        progress.background(priority == Priority::Background);
        // Dropping the turn on a cancel takes the work out of the queue.
        turn.wait_for_turn()?;
        Ok(turn)
    }

    fn wakers(&self, progress: &dyn Progress) -> Wakers {
        let cancel = progress.cancel_token().map(|token| {
            let shared = self.shared.clone();
            token.on_cancel(move || shared.nudge())
        });
        let pause = progress.pause_token().map(|token| {
            let shared = self.shared.clone();
            token.on_change(move || shared.nudge())
        });
        Wakers {
            _cancel: cancel,
            _pause: pause,
        }
    }

    /// Readies `root_id` for removal, as glazier-core's `removeRoot` does: refused while asked-for
    /// work on it waits or runs; its background analysis, which is only worth finishing for a
    /// root that stays, is stopped, and this returns once that has let go of its turn.
    pub(crate) fn stop_work_on(&self, root_id: RootId) -> Result<(), RootBusy> {
        let stopping: Vec<(u64, CancelToken)> = {
            let queue = self.shared.lock();
            let on_root: Vec<&Entry> = queue
                .entries
                .iter()
                .filter(|entry| entry.roots.contains(&root_id))
                .collect();
            if on_root
                .iter()
                .any(|entry| !entry.is_background() || entry.cancel.is_none())
            {
                return Err(RootBusy);
            }
            on_root
                .iter()
                .filter_map(|entry| Some((entry.id, entry.cancel.clone()?)))
                .collect()
        };
        // Cancelled outside the lock: each cancel wakes the queue, which takes the lock.
        for (_, token) in &stopping {
            token.cancel();
        }
        let mut queue = self.shared.lock();
        while stopping.iter().any(|(id, _)| queue.entry(*id).is_some()) {
            queue = self.shared.wait(queue);
        }
        Ok(())
    }

    /// Makes background analysis of `root_id` asked-for, as "Check now" does in glazier-core when
    /// such a job waits; here it reaches one that is running or stepped aside as well, so the
    /// same files are not analysed twice. Says whether there was any.
    pub(crate) fn promote(&self, root_id: RootId) -> bool {
        let mut queue = self.shared.lock();
        let mut promoted = false;
        for entry in &mut queue.entries {
            if entry.is_background() && entry.roots.contains(&root_id) {
                entry.background.store(false, Ordering::Release);
                // Stepped aside, it now waits as asked-for work does, in its place in the queue.
                if entry.place == Place::SteppedAside {
                    entry.place = Place::Waiting;
                }
                promoted = true;
            }
        }
        self.shared.changed(&queue);
        promoted
    }

    /// How many pieces of work wait for their turn, for "2 more queued".
    pub(crate) fn waiting(&self) -> usize {
        self.shared
            .lock()
            .entries
            .iter()
            .filter(|entry| entry.place != Place::Running)
            .count()
    }
}

/// The callbacks that wake the queue when a turn's work is paused, resumed or cancelled.
struct Wakers {
    _cancel: Option<CancelCallback>,
    _pause: Option<PauseCallback>,
}

/// A piece of work's turn, held while it runs; dropping it lets the next piece of work go. It is
/// the work's [`Progress`]: reports go through to the caller's, and its checkpoint waits for the
/// turn as well as for a pause.
pub(crate) struct Turn<'a> {
    shared: &'a Shared,
    id: u64,
    background: Arc<AtomicBool>,
    /// What the caller's progress was last told, so a promotion is reported once.
    reported_background: AtomicBool,
    progress: &'a dyn Progress,
    _wakers: Wakers,
}

impl Turn<'_> {
    fn is_background(&self) -> bool {
        let background = self.background.load(Ordering::Acquire);
        if self.reported_background.swap(background, Ordering::AcqRel) != background {
            self.progress.background(background);
        }
        background
    }

    fn is_paused(&self) -> bool {
        self.progress
            .pause_token()
            .is_some_and(PauseToken::is_paused)
    }

    fn should_step_aside(&self) -> bool {
        self.is_background() && self.shared.asked_for_waiting.load(Ordering::Acquire) > 0
    }

    /// Waits until the queue gives this work the turn.
    fn wait_for_turn(&self) -> Result<(), Cancelled> {
        let mut queue = self.shared.lock();
        if queue.may_run(self.id) {
            self.start(&mut queue);
            return Ok(());
        }
        drop(queue);
        self.progress.waiting(true);
        let mut queue = self.shared.lock();
        let outcome = loop {
            if let Err(cancelled) = self.progress.check() {
                break Err(cancelled);
            }
            if queue.may_run(self.id) {
                self.start(&mut queue);
                break Ok(());
            }
            queue = self.shared.wait(queue);
        };
        drop(queue);
        self.progress.waiting(false);
        outcome
    }

    fn start(&self, queue: &mut Queue) {
        if let Some(entry) = queue.entry_mut(self.id) {
            entry.place = Place::Running;
        }
        self.shared.changed(queue);
    }

    /// Lets asked-for work go first, then waits to go on.
    fn step_aside(&self) -> Result<(), Cancelled> {
        {
            let mut queue = self.shared.lock();
            if let Some(entry) = queue.entry_mut(self.id) {
                entry.place = Place::SteppedAside;
            }
            self.shared.changed(&queue);
        }
        self.wait_for_turn()
    }

    /// Waits while paused, unless a cancel comes or (in the background) asked-for work arrives.
    fn wait_while_paused(&self) {
        let mut queue = self.shared.lock();
        while self.is_paused() && self.progress.check().is_ok() && !self.should_step_aside() {
            queue = self.shared.wait(queue);
        }
    }
}

impl Progress for Turn<'_> {
    fn phase(&self, label: &str, total: u64) {
        self.progress.phase(label, total);
    }

    fn done(&self, done: u64) {
        self.progress.done(done);
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        self.progress.cancel_token()
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        self.progress.pause_token()
    }

    fn waiting(&self, waiting: bool) {
        self.progress.waiting(waiting);
    }

    fn background(&self, background: bool) {
        self.progress.background(background);
    }

    fn wants_checkpoint(&self) -> bool {
        self.check().is_err() || self.is_paused() || self.should_step_aside()
    }

    fn checkpoint(&self) -> Result<(), Cancelled> {
        loop {
            self.check()?;
            if self.should_step_aside() {
                self.step_aside()?;
                continue;
            }
            if self.is_paused() {
                self.wait_while_paused();
                continue;
            }
            return Ok(());
        }
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let mut queue = self.shared.lock();
        queue.entries.retain(|entry| entry.id != self.id);
        self.shared.changed(&queue);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::passes::{Quiet, run_concurrently};

    /// A record of what happened, in order, across threads.
    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<String>>>);

    impl Log {
        fn push(&self, line: impl Into<String>) {
            self.0.lock().unwrap().push(line.into());
        }

        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }

        fn wait_for(&self, line: &str) {
            for _ in 0..500 {
                if self.lines().iter().any(|seen| seen == line) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            panic!("never saw {line:?} in {:?}", self.lines());
        }
    }

    /// Quiet progress that logs when it waits.
    struct Logged {
        name: &'static str,
        quiet: Quiet,
        log: Log,
    }

    impl Progress for Logged {
        fn phase(&self, _: &str, _: u64) {}

        fn done(&self, _: u64) {}

        fn cancel_token(&self) -> Option<&CancelToken> {
            self.quiet.cancel_token()
        }

        fn pause_token(&self) -> Option<&PauseToken> {
            self.quiet.pause_token()
        }

        fn waiting(&self, waiting: bool) {
            self.log.push(format!(
                "{} {}",
                self.name,
                if waiting { "waits" } else { "goes" }
            ));
        }
    }

    fn logged(name: &'static str, log: &Log) -> Logged {
        Logged {
            name,
            quiet: Quiet::new(),
            log: log.clone(),
        }
    }

    #[test]
    fn asked_for_work_runs_in_order_ahead_of_background_work() {
        let scheduler = Scheduler::default();
        let log = Log::default();
        let first = logged("first", &log);
        let held = scheduler
            .take_turn(Priority::AskedFor, vec![1], &first)
            .unwrap();
        let (done, finished) = mpsc::channel();
        std::thread::scope(|scope| {
            for (name, priority) in [
                ("background", Priority::Background),
                ("scan", Priority::AskedFor),
                ("change", Priority::AskedFor),
            ] {
                let (scheduler, lines, done) = (&scheduler, log.clone(), done.clone());
                scope.spawn(move || {
                    let progress = logged(name, &lines);
                    let _turn = scheduler.take_turn(priority, vec![1], &progress).unwrap();
                    lines.push(format!("{name} runs"));
                    done.send(()).unwrap();
                });
                log.wait_for(&format!("{name} waits"));
            }
            assert_eq!(scheduler.waiting(), 3);
            drop(held);
            for _ in 0..3 {
                finished.recv().unwrap();
            }
        });
        let runs: Vec<String> = log
            .lines()
            .into_iter()
            .filter(|line| line.ends_with(" runs"))
            .collect();
        assert_eq!(runs, ["scan runs", "change runs", "background runs"]);
    }

    #[test]
    fn background_work_steps_aside_with_nothing_in_flight_and_goes_on() {
        let scheduler = Scheduler::default();
        let log = Log::default();
        let items: Vec<u32> = (0..40).collect();
        std::thread::scope(|scope| {
            let (scheduler, lines, items) = (&scheduler, log.clone(), &items);
            let analysis = scope.spawn(move || {
                let progress = logged("analysis", &lines);
                let turn = scheduler
                    .take_turn(Priority::Background, vec![1], &progress)
                    .unwrap();
                lines.push("analysis starts");
                run_concurrently(items, 4, &turn, |item| {
                    if *item == 5 {
                        // The scan arrives while the analysis is under way.
                        lines.wait_for("scan waits");
                    }
                    std::thread::sleep(Duration::from_millis(2));
                    lines.push(format!("item {item}"));
                    Ok(())
                })
                .unwrap();
                lines.push("analysis ends");
            });
            log.wait_for("analysis starts");
            let lines = log.clone();
            let scan = scope.spawn(move || {
                let progress = logged("scan", &lines);
                let _turn = scheduler
                    .take_turn(Priority::AskedFor, vec![1], &progress)
                    .unwrap();
                lines.push("scan runs");
                std::thread::sleep(Duration::from_millis(30));
                lines.push("scan ends");
            });
            scan.join().unwrap();
            analysis.join().unwrap();
        });
        let lines = log.lines();
        let position = |line: &str| lines.iter().position(|seen| seen == line).unwrap();
        let (runs, ends) = (position("scan runs"), position("scan ends"));
        assert!(runs < position("analysis ends"), "{lines:?}");
        assert!(
            lines[runs..ends]
                .iter()
                .all(|line| !line.starts_with("item ")),
            "nothing of the analysis was in flight while the scan ran: {lines:?}"
        );
        assert!(
            lines[ends..].iter().any(|line| line.starts_with("item ")),
            "the analysis went on after: {lines:?}"
        );
        let items_done = lines
            .iter()
            .filter(|line| line.starts_with("item "))
            .count();
        assert_eq!(items_done, 40, "every item ran once: {lines:?}");
        assert!(lines.contains(&"analysis waits".to_owned()), "{lines:?}");
    }

    #[test]
    fn promoted_background_work_goes_first_in_its_place() {
        let scheduler = Scheduler::default();
        let log = Log::default();
        let first = logged("first", &log);
        let held = scheduler
            .take_turn(Priority::AskedFor, vec![1], &first)
            .unwrap();
        let (done, finished) = mpsc::channel();
        std::thread::scope(|scope| {
            for (name, priority, root) in [
                ("analysis", Priority::Background, 2),
                ("scan", Priority::AskedFor, 1),
            ] {
                let (scheduler, lines, done) = (&scheduler, log.clone(), done.clone());
                scope.spawn(move || {
                    let progress = logged(name, &lines);
                    let _turn = scheduler
                        .take_turn(priority, vec![root], &progress)
                        .unwrap();
                    lines.push(format!("{name} runs"));
                    done.send(()).unwrap();
                });
                log.wait_for(&format!("{name} waits"));
            }
            // "Check now" on root 2: its analysis now runs as asked for, and it was asked first.
            assert!(scheduler.promote(2));
            assert!(!scheduler.promote(3));
            drop(held);
            finished.recv().unwrap();
            finished.recv().unwrap();
        });
        let runs: Vec<String> = log
            .lines()
            .into_iter()
            .filter(|line| line.ends_with(" runs"))
            .collect();
        assert_eq!(runs, ["analysis runs", "scan runs"]);
    }

    #[test]
    fn a_paused_turn_waits_and_stops_on_cancel() {
        let scheduler = Scheduler::default();
        let log = Log::default();
        let progress = logged("change", &log);
        let turn = scheduler
            .take_turn(Priority::AskedFor, vec![1], &progress)
            .unwrap();
        progress.quiet.pause().pause();
        assert!(turn.wants_checkpoint());
        let cancel = progress.quiet.token().clone();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                cancel.cancel();
            });
            assert_eq!(turn.checkpoint(), Err(Cancelled));
        });
    }

    #[test]
    fn a_root_with_asked_for_work_is_not_removed_and_background_work_on_it_stops() {
        let scheduler = Scheduler::default();
        let log = Log::default();
        let scan = logged("scan", &log);
        let turn = scheduler
            .take_turn(Priority::AskedFor, vec![1], &scan)
            .unwrap();
        assert!(scheduler.stop_work_on(1).is_err());
        assert!(scheduler.stop_work_on(2).is_ok(), "other roots are free");
        drop(turn);

        std::thread::scope(|scope| {
            let (scheduler, background_log) = (&scheduler, log.clone());
            let analysis = scope.spawn(move || {
                let progress = logged("analysis", &background_log);
                let turn = scheduler
                    .take_turn(Priority::Background, vec![1], &progress)
                    .unwrap();
                progress.quiet.pause().pause();
                background_log.push("paused");
                turn.checkpoint()
            });
            log.wait_for("paused");
            scheduler.stop_work_on(1).unwrap();
            assert_eq!(analysis.join().unwrap(), Err(Cancelled));
        });
        assert_eq!(scheduler.waiting(), 0);
    }
}
