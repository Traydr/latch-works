//! Tidy's jobs in the shell's activity panel, as a GPUI Kit headless UI test: what runs and what
//! waits behind it, a change started while another runs joining the queue, Pause, Resume and Stop
//! from the panel, and nothing shown once Tidy is idle.

mod support;

use gpui_kit::{AppContext as _, TestAppContext};
use oriel_mode_tidy::{TidyPage, last_toast};
use oriel_ui::{JobState, ModeId};
use support::*;

/// Where Tidy's job `key` is, as it published it to the panel.
fn job_state(cx: &mut TestAppContext, session: &Session, key: &str) -> Option<JobState> {
    cx.read(|cx| {
        session
            .shell
            .read(cx)
            .jobs()
            .read(cx)
            .jobs_of(ModeId::Tidy)
            .iter()
            .find(|job| job.key().as_ref() == key)
            .map(|job| job.job_state())
    })
}

#[gpui_kit::test]
async fn the_panel_lists_running_and_queued_jobs_and_pauses_and_stops_them(
    cx: &mut TestAppContext,
) {
    let session = launch_changing(cx, "activity");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Convert);
    settle(cx, &session).await;
    // Nothing runs, so nothing shows.
    assert!(label(cx, &session, "activity-indicator").is_none());

    // A rescan paused before its first step keeps its turn, so the changes asked for next wait.
    let state = session.state.clone();
    let root_id = cx.read(|cx| state.read(cx).root_id().unwrap());
    cx.update_window(session.handle, |_, window, cx| {
        state.update(cx, |state, cx| {
            state.start_scan(root_id, window, cx);
            let scan = state.scan().unwrap().job.clone();
            scan.update(cx, |job, cx| job.set_paused(true, cx));
        });
    })
    .unwrap();
    wait_for(cx, &session, "the paused scan", |cx| {
        let jobs = session.shell.read(cx).jobs().read(cx);
        jobs.jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().as_ref() == "scan" && job.job_state() == JobState::Paused)
    })
    .await;
    let indicator = label(cx, &session, "activity-indicator").unwrap();
    assert!(
        indicator.starts_with("Tidy · ") && indicator.ends_with(" · Paused"),
        "{indicator}"
    );

    // Convert's change drafts its plan, then waits for the scan's turn: queued.
    click(cx, &session, "convert-run");
    wait_for(cx, &session, "the conversion to wait", |cx| {
        let jobs = session.shell.read(cx).jobs().read(cx);
        jobs.jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().as_ref() == "change" && job.job_state() == JobState::Queued)
    })
    .await;
    // Clean up, asked for while Convert holds the turn, joins Tidy's queue and says so.
    go(cx, &session, TidyPage::CleanUp);
    click(cx, &session, "cleanup-run-all");
    assert_eq!(job_state(cx, &session, "queued-0"), Some(JobState::Queued));
    assert_eq!(
        label(cx, &session, "cleanup-run-all").as_deref(),
        Some("Queued")
    );
    assert_eq!(
        label(cx, &session, "activity-indicator-queued").as_deref(),
        Some("2 queued")
    );

    // The panel lists each job with where it is.
    click(cx, &session, "activity-indicator");
    assert!(label(cx, &session, "activity-panel").is_some());
    assert_eq!(
        label(cx, &session, "activity-panel-counts").as_deref(),
        Some("1 running · 2 queued")
    );
    assert_eq!(
        label(cx, &session, "activity-tidy-scan-state").as_deref(),
        Some("Paused")
    );
    assert_eq!(
        label(cx, &session, "activity-tidy-change-state").as_deref(),
        Some("Queued")
    );
    assert_eq!(
        label(cx, &session, "activity-tidy-queued-0").as_deref(),
        Some("Tidy · Clean up")
    );
    // Waiting work has nothing to pause yet; the paused scan resumes.
    assert!(label(cx, &session, "activity-tidy-change-pause").is_none());
    assert_eq!(
        label(cx, &session, "activity-tidy-scan-pause").as_deref(),
        Some("Resume")
    );

    // Stop takes the queued Clean up off the queue; its page can start it again.
    click(cx, &session, "activity-tidy-queued-0-stop");
    assert_eq!(job_state(cx, &session, "queued-0"), None);
    assert_ne!(
        label(cx, &session, "cleanup-run-all").as_deref(),
        Some("Queued")
    );
    // Stop ends the waiting conversion before it has changed anything.
    click(cx, &session, "activity-tidy-change-stop");
    wait_for(cx, &session, "the conversion to stop", |cx| {
        !session
            .shell
            .read(cx)
            .jobs()
            .read(cx)
            .jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().as_ref() == "change")
    })
    .await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Stopped"));
    assert!(session.archive.join("clips/talk.mov").is_file());

    // Resume lets the rescan finish, and with Tidy idle the indicator goes.
    click(cx, &session, "activity-tidy-scan-pause");
    settle(cx, &session).await;
    assert!(label(cx, &session, "activity-panel").is_none());
    assert!(label(cx, &session, "activity-indicator").is_none());
}
