//! The bounded worker pool of plan 035 (`runQueue` in `scan.ts`): at most `concurrency` tasks at
//! once, tasks may add more while they run, and the first error or a cancel stops the rest.
//!
//! The TypeScript runs its tasks as promises on one thread; here each worker is a thread of a
//! scope, so blocking file reads overlap the way Node's thread pool overlaps them.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, PoisonError};

use oriel_runtime::CancelToken;

/// The concurrency a scan uses when none is given, and the range it accepts.
pub(crate) const DEFAULT_CONCURRENCY: usize = 4;
pub(crate) const MAX_CONCURRENCY: usize = 16;

/// `concurrency()` in `scan.ts`: 4 by default, else 1 to 16.
pub(crate) fn concurrency(value: Option<usize>) -> anyhow::Result<usize> {
    match value {
        None => Ok(DEFAULT_CONCURRENCY),
        Some(value) if (1..=MAX_CONCURRENCY).contains(&value) => Ok(value),
        Some(_) => anyhow::bail!("Scan concurrency must be an integer between 1 and 16"),
    }
}

struct State<T> {
    queue: VecDeque<T>,
    active: usize,
    failed: Option<anyhow::Error>,
}

/// The queue a running task adds to.
pub(crate) struct Queue<'a, T> {
    state: &'a Mutex<State<T>>,
    wake: &'a Condvar,
}

impl<T> Queue<'_, T> {
    /// Adds a task for a free worker. Tasks added after the run has failed are dropped.
    pub(crate) fn add(&self, task: T) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.failed.is_none() {
            state.queue.push_back(task);
            self.wake.notify_one();
        }
    }

    /// Whether the run still goes on: no task has failed and it was not cancelled.
    pub(crate) fn is_running(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .failed
            .is_none()
    }
}

/// Runs `work` over `tasks`, and over whatever the tasks add, `concurrency` at a time, until
/// none is left. The first error (or the cancel, checked before each task) is the result; tasks
/// already running finish, and no new one starts.
pub(crate) fn run_queue<T, W>(
    concurrency: usize,
    tasks: Vec<T>,
    cancel: Option<&CancelToken>,
    work: W,
) -> anyhow::Result<()>
where
    T: Send,
    W: Fn(T, &Queue<'_, T>) -> anyhow::Result<()> + Sync,
{
    if tasks.is_empty() {
        return Ok(());
    }
    let state = Mutex::new(State {
        queue: tasks.into(),
        active: 0,
        failed: None,
    });
    let wake = Condvar::new();
    let queue = Queue {
        state: &state,
        wake: &wake,
    };

    std::thread::scope(|scope| {
        for _ in 0..concurrency.max(1) {
            scope.spawn(|| worker(&queue, cancel, &work));
        }
    });

    match state
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner)
        .failed
    {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn worker<T, W>(queue: &Queue<'_, T>, cancel: Option<&CancelToken>, work: &W)
where
    W: Fn(T, &Queue<'_, T>) -> anyhow::Result<()>,
{
    loop {
        let task = {
            let mut state = queue.state.lock().unwrap_or_else(PoisonError::into_inner);
            loop {
                if state.failed.is_some() {
                    queue.wake.notify_all();
                    return;
                }
                if let Some(cancelled) = cancel.and_then(|token| token.check().err()) {
                    state.failed = Some(cancelled.into());
                    queue.wake.notify_all();
                    return;
                }
                if let Some(task) = state.queue.pop_front() {
                    state.active += 1;
                    break task;
                }
                if state.active == 0 {
                    // Nothing queued and nothing running that could add more: done.
                    queue.wake.notify_all();
                    return;
                }
                state = queue
                    .wake
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
            }
        };

        let outcome = work(task, queue);

        let mut state = queue.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.active -= 1;
        if let Err(error) = outcome
            && state.failed.is_none()
        {
            state.failed = Some(error);
        }
        queue.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;

    #[test]
    fn concurrency_defaults_to_four_within_one_to_sixteen() {
        assert_eq!(concurrency(None).unwrap(), 4);
        assert_eq!(concurrency(Some(1)).unwrap(), 1);
        assert_eq!(concurrency(Some(16)).unwrap(), 16);
        assert!(concurrency(Some(0)).is_err());
        assert!(concurrency(Some(17)).is_err());
    }

    /// The pool never runs more than its bound at once, and runs what tasks add.
    #[test]
    fn runs_at_most_its_bound_and_what_tasks_add() {
        let running = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        run_queue(3, (0..4).collect(), None, |depth: usize, queue| {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
            if depth < 2 {
                queue.add(depth + 1);
                queue.add(depth + 1);
            }
            running.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        // Four roots, 0 to 3. Root 0 adds two 1s, which add two 2s each; root 1 adds two 2s; a
        // 2 or a 3 adds nothing.
        assert_eq!(done.load(Ordering::SeqCst), 4 + 2 + 4 + 2);
    }

    #[test]
    fn the_first_error_stops_the_run() {
        let started = AtomicUsize::new(0);
        let result = run_queue(1, (0..10).collect(), None, |task: usize, _| {
            started.fetch_add(1, Ordering::SeqCst);
            anyhow::ensure!(task != 2, "task 2 failed");
            Ok(())
        });
        assert_eq!(result.unwrap_err().to_string(), "task 2 failed");
        assert_eq!(started.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_cancel_stops_dequeuing() {
        let token = CancelToken::new();
        let started = AtomicUsize::new(0);
        let result = run_queue(1, (0..10).collect(), Some(&token), |task: usize, _| {
            started.fetch_add(1, Ordering::SeqCst);
            if task == 1 {
                token.cancel();
            }
            Ok(())
        });
        assert!(result.unwrap_err().is::<oriel_runtime::Cancelled>());
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }
}
