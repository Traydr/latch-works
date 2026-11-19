//! Tidy's jobs in the shell's activity panel, as a GPUI Kit headless UI test: what runs and what
//! waits behind it, a change started while another runs joining the queue, Pause, Resume and Stop
//! from the panel, and nothing shown once Tidy is idle.

use crate::support::*;
use gpui_kit::{AppContext as _, TestAppContext};
use oriel_core_tidy::TidyStep;
use oriel_core_tidy::contract::PlanRequest;
use oriel_mode_tidy::TidyPage;
use oriel_ui::toast::last_toast;
use oriel_ui::{JobState, ModeId};

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
    let session = launch(cx, "activity");
    add_archive(cx, &session).await;
    go(cx, &session, TidyPage::Overview);
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
            scan.set_paused(true, cx);
        });
    })
    .unwrap();
    wait_for(cx, &session, "the paused scan", |cx| {
        let jobs = session.shell.read(cx).jobs().read(cx);
        jobs.jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().starts_with("scan-") && job.job_state() == JobState::Paused)
    })
    .await;
    let scan = job_keys(cx, &session, "scan-")[0].clone();
    // It shows once the work has run long enough to say.
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(300));
    cx.run_until_parked();
    let indicator = label(cx, &session, "activity-indicator").unwrap();
    assert!(
        indicator.starts_with("Tidy · ") && indicator.ends_with(" · Paused"),
        "{indicator}"
    );

    // Tidy up drafts its plan, then waits for the scan's turn: queued.
    click(cx, &session, "overview-tidy-up");
    wait_for(cx, &session, "Tidy up to wait", |cx| {
        let jobs = session.shell.read(cx).jobs().read(cx);
        jobs.jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().starts_with("change-") && job.job_state() == JobState::Queued)
    })
    .await;
    let convert = job_keys(cx, &session, "change-")[0].clone();
    // A clean-up asked for while Tidy up holds the turn joins Tidy's queue.
    cx.update_window(session.handle, |_, window, cx| {
        state.update(cx, |state, cx| {
            state.perform_steps(
                "Clean up",
                vec![TidyStep::Plan(PlanRequest::Cleanup { root_id })],
                "Cleaned up".into(),
                "test:cleanup",
                window,
                cx,
            );
        });
    })
    .unwrap();
    let cleanup = job_keys(cx, &session, "change-")[1].clone();
    assert_eq!(job_state(cx, &session, &cleanup), Some(JobState::Queued));
    assert_eq!(
        label(cx, &session, "activity-indicator-queued").as_deref(),
        Some("2 queued")
    );

    // The panel lists each job with where it is.
    let_toast_land(cx, &session);
    click(cx, &session, "activity-indicator");
    assert!(label(cx, &session, "activity-panel").is_some());
    assert_eq!(
        label(cx, &session, "activity-panel-counts").as_deref(),
        Some("1 paused · 2 queued")
    );
    assert_eq!(
        label(cx, &session, format!("activity-tidy-{scan}-state")).as_deref(),
        Some("Paused")
    );
    assert_eq!(
        label(cx, &session, format!("activity-tidy-{convert}-state")).as_deref(),
        Some("Queued")
    );
    assert_eq!(
        label(cx, &session, format!("activity-tidy-{cleanup}")).as_deref(),
        Some("Tidy · Clean up")
    );
    // Waiting work has nothing to pause yet; the paused scan resumes.
    assert!(label(cx, &session, format!("activity-tidy-{convert}-pause")).is_none());
    assert_eq!(
        label(cx, &session, format!("activity-tidy-{scan}-pause")).as_deref(),
        Some("Resume")
    );

    // Stop takes the queued clean-up off the queue.
    click(cx, &session, format!("activity-tidy-{cleanup}-stop"));
    assert_eq!(job_state(cx, &session, &cleanup), None);
    // Stop ends the waiting Tidy up before it has changed anything.
    let_toast_land(cx, &session);
    click(cx, &session, format!("activity-tidy-{convert}-stop"));
    wait_for(cx, &session, "Tidy up to stop", |cx| {
        !session
            .shell
            .read(cx)
            .jobs()
            .read(cx)
            .jobs_of(ModeId::Tidy)
            .iter()
            .any(|job| job.key().as_ref() == convert)
    })
    .await;
    assert_eq!(cx.read(last_toast).as_deref(), Some("Stopped"));
    assert!(session.archive.join("clips/talk.mov").is_file());

    // Resume lets the rescan finish, and with Tidy idle the indicator goes.
    let_toast_land(cx, &session);
    click(cx, &session, format!("activity-tidy-{scan}-pause"));
    settle(cx, &session).await;
    assert!(label(cx, &session, "activity-panel").is_none());
    assert!(label(cx, &session, "activity-indicator").is_none());
}
