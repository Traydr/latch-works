//! Jobs as the UI sees them: progress reaches an observer while the work runs, the value or the
//! error arrives once as an event, cancelling midway fails the job as cancelled, and dropping the
//! last handle cancels the work.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui_kit::{Entity, Subscription, TestAppContext};
use oriel_runtime::{CancelToken, Job, JobError, JobEvent, JobStatus};

/// A job of `steps` steps that waits for a permit from the test before each step, so the test
/// decides how far it has got when it looks. Each step checks for cancellation first.
fn start_gated(
    cx: &mut TestAppContext,
    steps: u64,
) -> (Entity<Job<u64>>, mpsc::UnboundedSender<()>) {
    let (permits, mut gate) = mpsc::unbounded::<()>();
    let job = cx.update(|cx| {
        Job::start("Count", cx, move |reporter| async move {
            reporter.begin_phase("Counting", steps);
            for _ in 0..steps {
                let cancelled = std::pin::pin!(reporter.cancelled());
                futures::future::select(gate.next(), cancelled).await;
                reporter.check()?;
                reporter.advance(1);
            }
            Ok(steps * 10)
        })
    });
    (job, permits)
}

/// What an observer saw on each notification, and what a subscriber heard.
#[derive(Default)]
struct Seen {
    progress: Vec<(String, u64, u64)>,
    events: Vec<String>,
}

fn watch(
    cx: &mut TestAppContext,
    job: &Entity<Job<u64>>,
) -> (Rc<RefCell<Seen>>, [Subscription; 2]) {
    let seen = Rc::new(RefCell::new(Seen::default()));
    let subscriptions = cx.update(|cx| {
        let observed = seen.clone();
        let observing = cx.observe(job, move |job, cx| {
            let progress = job.read(cx).progress();
            observed.borrow_mut().progress.push((
                progress.phase().to_string(),
                progress.done(),
                progress.total(),
            ));
        });
        let heard = seen.clone();
        let subscribing = cx.subscribe(job, move |_, event: &JobEvent, _| {
            heard.borrow_mut().events.push(match event {
                JobEvent::Succeeded => "succeeded".to_owned(),
                JobEvent::Failed(error) => format!("failed: {error}"),
            });
        });
        [observing, subscribing]
    });
    (seen, subscriptions)
}

fn permit(permits: &mpsc::UnboundedSender<()>, count: usize) {
    for _ in 0..count {
        permits.unbounded_send(()).unwrap();
    }
}

#[gpui_kit::test]
fn a_job_reports_progress_and_finishes_with_its_value(cx: &mut TestAppContext) {
    let (job, permits) = start_gated(cx, 5);
    let (seen, _subscriptions) = watch(cx, &job);

    permit(&permits, 2);
    cx.run_until_parked();
    cx.read(|cx| {
        let job = job.read(cx);
        assert!(job.is_running());
        assert_eq!(job.name().as_ref(), "Count");
        assert_eq!(job.progress().phase().as_ref(), "Counting");
        assert_eq!((job.progress().done(), job.progress().total()), (2, 5));
        assert_eq!(job.progress().fraction(), Some(0.4));
    });
    assert_eq!(
        seen.borrow().progress.last(),
        Some(&("Counting".to_owned(), 2, 5))
    );
    assert!(seen.borrow().events.is_empty());

    permit(&permits, 3);
    cx.run_until_parked();
    cx.read(|cx| {
        let job = job.read(cx);
        assert!(matches!(job.status(), JobStatus::Succeeded(50)));
        assert_eq!(job.value(), Some(&50));
        assert_eq!(job.progress().done(), 5);
    });
    assert_eq!(seen.borrow().events, ["succeeded"]);
}

#[gpui_kit::test]
fn a_job_cancelled_midway_fails_as_cancelled(cx: &mut TestAppContext) {
    let (job, permits) = start_gated(cx, 10);
    let (seen, _subscriptions) = watch(cx, &job);

    permit(&permits, 3);
    cx.run_until_parked();
    assert_eq!(cx.read(|cx| job.read(cx).progress().done()), 3);

    job.update(cx, |job, cx| job.cancel(cx));
    assert!(cx.read(|cx| job.read(cx).is_cancelling()));
    // No permit comes: the work stops because it awaits cancellation as well.
    cx.run_until_parked();

    cx.read(|cx| {
        let job = job.read(cx);
        assert!(!job.is_running());
        assert!(job.error().is_some_and(JobError::is_cancelled));
        assert_eq!(job.progress().done(), 3, "progress stops where the job did");
    });
    assert_eq!(seen.borrow().events, ["failed: Cancelled"]);
}

#[gpui_kit::test]
fn an_error_reaches_the_observer_with_its_causes(cx: &mut TestAppContext) {
    let job = cx.update(|cx| {
        Job::start("Hash", cx, |reporter| async move {
            reporter.begin_phase("Hashing", 0);
            Err::<u64, _>(anyhow::anyhow!("disk full").context("hashing archive/a.jpg"))
        })
    });
    let (seen, _subscriptions) = watch(cx, &job);
    cx.run_until_parked();

    let error = cx.read(|cx| job.read(cx).error().cloned()).unwrap();
    assert!(!error.is_cancelled());
    assert_eq!(error.message().as_ref(), "hashing archive/a.jpg: disk full");
    assert_eq!(
        seen.borrow().events,
        ["failed: hashing archive/a.jpg: disk full"]
    );
    assert_eq!(cx.read(|cx| job.read(cx).progress().fraction()), None);
}

/// Stands in for a parser that panics on a file it did not expect.
fn parse_header(bytes: &[u8]) -> u64 {
    assert!(bytes.len() >= 8, "corrupt header");
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}

#[gpui_kit::test]
fn a_panic_fails_the_job_rather_than_the_app(cx: &mut TestAppContext) {
    let job =
        cx.update(|cx| Job::start("Probe", cx, |_| async move { Ok(parse_header(b"short")) }));
    cx.run_until_parked();
    let message = cx.read(|cx| job.read(cx).error().map(JobError::message));
    assert_eq!(message.as_deref(), Some("panicked: corrupt header"));
}

/// Set when the work's future is dropped, which is how a job's work stops at an await.
struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[gpui_kit::test]
fn dropping_the_last_handle_cancels_the_job(cx: &mut TestAppContext) {
    let token = Arc::new(Mutex::new(None::<CancelToken>));
    let dropped = Arc::new(AtomicBool::new(false));
    let job = cx.update(|cx| {
        let token = token.clone();
        let flag = DropFlag(dropped.clone());
        Job::start("Wait", cx, move |reporter| async move {
            let _flag = flag;
            *token.lock().unwrap() = Some(reporter.cancel_token().clone());
            std::future::pending::<()>().await;
            Ok(0u64)
        })
    });
    cx.run_until_parked();
    let token = token.lock().unwrap().clone().expect("the work started");
    assert!(!token.is_cancelled());
    assert!(!dropped.load(Ordering::SeqCst));

    drop(job);
    // GPUI releases dropped entities when it next flushes effects, as every update ends by doing.
    cx.update(|_| {});
    cx.run_until_parked();
    assert!(
        token.is_cancelled(),
        "work that checks the token sees the cancel"
    );
    assert!(
        dropped.load(Ordering::SeqCst),
        "work that awaits is dropped"
    );
}
