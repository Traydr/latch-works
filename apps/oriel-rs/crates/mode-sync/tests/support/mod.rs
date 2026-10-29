//! Electron Oriel's `e2e/tests/lockstep/sync.spec.ts` as GPUI tests: five cases in order against
//! one Pane View, driven through Sync's real views with clicks and typing, and checked on screen,
//! in Pane View's snapshot and on disk. `sync.rs` runs them against a small Pane View on a local
//! port; `stack.rs` against the local compose stack.

// Each test binary uses part of this.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, TestAppContext, WindowBounds, WindowOptions,
    px, size,
};
use oriel_core_paths::DataRoot;
use oriel_core_sync::{ApiTarget, PaneViewClient};
use oriel_mode_sync::{PruneAvailability, Screen, SyncMode};
use oriel_runtime::{CancelToken, TokioRuntime};
use oriel_ui::{ModeId, ShellState};

pub const PROFILE_NAME: &str = "E2E archive";

/// The Pane View the cases run against, and what it holds before them.
pub struct Target {
    pub url: String,
    pub token: String,
    /// The two-file source the cases push (`LOCKSTEP_SOURCE_DIR`).
    pub source: PathBuf,
    /// The seeded archive, where the file that comes back in case four is copied from.
    pub archive: PathBuf,
    /// The source's files, as archive paths.
    pub source_items: Vec<String>,
}

pub fn open_sync(cx: &mut TestAppContext, data: &DataRoot) -> (AnyWindowHandle, Entity<SyncMode>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        oriel_ui::theme::init(cx);
    });
    let data = data.clone();
    cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(1320.), px(860.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let shell = cx.new(|_| ShellState::new(ModeId::Sync, false));
                cx.new(|cx| SyncMode::with_data(&shell, &data, window, cx))
            },
        )
        .expect("open the test window")
    })
}

fn frame(cx: &mut TestAppContext, handle: AnyWindowHandle) {
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
}

/// Waits for the run on screen to end: its HTTP and file work run on other threads.
pub fn wait_for_run(cx: &mut TestAppContext, handle: AnyWindowHandle, sync: &Entity<SyncMode>) {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        frame(cx, handle);
        if !cx.update(|cx| sync.read(cx).is_running()) {
            frame(cx, handle);
            return;
        }
        assert!(Instant::now() < deadline, "the run did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn type_into(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &'static str, text: &str) {
    let text = text.to_owned();
    cx.update_window(handle, move |_, window, cx| {
        window.click(id, cx);
        window.input(&text, cx);
    })
    .unwrap();
}

fn label(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &str) -> Option<String> {
    let id = gpui_kit::SharedString::from(id.to_owned());
    cx.update_window(handle, move |_, window, _| {
        window
            .try_find(id)
            .and_then(|found| found.label().map(str::to_owned))
    })
    .unwrap()
}

fn click(cx: &mut TestAppContext, handle: AnyWindowHandle, id: &str) {
    let id = gpui_kit::SharedString::from(id.to_owned());
    cx.update_window(handle, move |_, window, cx| window.click(id, cx))
        .unwrap();
    frame(cx, handle);
}

/// A run panel figure, such as "pushed 2 / 2": the count before any "/ total".
fn stat(cx: &mut TestAppContext, handle: AnyWindowHandle, name: &str) -> String {
    label(cx, handle, &format!("run-stat-{name}"))
        .unwrap_or_else(|| panic!("no {name} figure"))
        .split('/')
        .next()
        .unwrap()
        .trim()
        .to_owned()
}

/// Pane View's paths now, read with the token as the spec's `readRemotePaths` does.
pub fn remote_paths(target: &Target) -> Vec<String> {
    let runtime = TokioRuntime::start("sync-test-snapshot").unwrap();
    let client = PaneViewClient::new(ApiTarget {
        url: target.url.clone(),
        token: target.token.clone(),
    })
    .unwrap();
    let mut paths: Vec<String> = futures::executor::block_on(
        runtime.spawn(async move { client.fetch_snapshot(Some(&CancelToken::new())).await }),
    )
    .unwrap()
    .unwrap()
    .into_iter()
    .map(|entry| entry.path)
    .collect();
    paths.sort();
    paths
}

/// The five cases, in the spec's order, on one window and one Pane View.
pub fn run_sync_spec(cx: &mut TestAppContext, target: &Target, data_folder: &Path) {
    cx.executor().allow_parking();
    let data = DataRoot::at(data_folder.to_path_buf()).unwrap();
    let (handle, sync) = open_sync(cx, &data);
    frame(cx, handle);

    // A profile is created against the running Pane View.
    click(cx, handle, "sync-add-profile");
    assert_eq!(
        cx.update(|cx| sync.read(cx).screen().clone()),
        Screen::Form { editing: None }
    );
    type_into(cx, handle, "profile-name", PROFILE_NAME);
    type_into(cx, handle, "profile-api-url", &target.url);
    type_into(
        cx,
        handle,
        "profile-source-root",
        &target.source.to_string_lossy(),
    );
    type_into(cx, handle, "profile-token", &target.token);
    click(cx, handle, "profile-save");
    let profile_id = cx.update(|cx| {
        let sync = sync.read(cx);
        assert_eq!(sync.error(), None);
        let profile = sync
            .profiles()
            .active_profile()
            .expect("the profile is active");
        assert_eq!(profile.name, PROFILE_NAME);
        profile.id.clone()
    });
    cx.update_window(handle, |_, window, _| {
        let row = window.find(gpui_kit::SharedString::from(format!(
            "sync-profile-{profile_id}"
        )));
        assert_eq!(row.label(), Some(PROFILE_NAME));
        assert_eq!(row.selected(), Some(true));
    })
    .unwrap();
    assert_eq!(
        label(cx, handle, "sync-source-root").as_deref(),
        Some(target.source.to_string_lossy().as_ref())
    );

    // Plan reports the source as uploads, and push lands them in Pane View.
    click(cx, handle, "sync-plan");
    wait_for_run(cx, handle, &sync);
    let uploads = target.source_items.len();
    assert_eq!(
        label(cx, handle, "plan-count-upload").as_deref(),
        Some(format!("{uploads} to upload").as_str()),
        "error: {:?}",
        cx.update(|cx| sync.read(cx).error().map(str::to_owned))
    );
    click(cx, handle, "sync-push");
    wait_for_run(cx, handle, &sync);
    assert_eq!(stat(cx, handle, "pushed"), uploads.to_string());
    assert_eq!(
        label(cx, handle, "run-title").as_deref(),
        Some("Push complete")
    );
    assert_eq!(stat(cx, handle, "failed"), "0");
    click(cx, handle, "run-done");
    assert!(cx.update(|cx| !sync.read(cx).shows_run_panel()));
    let remote = remote_paths(target);
    for item in &target.source_items {
        assert!(remote.contains(item), "{item} is not in Pane View");
    }

    // A second plan has nothing to upload.
    click(cx, handle, "sync-plan");
    wait_for_run(cx, handle, &sync);
    assert_eq!(
        label(cx, handle, "plan-count-keep").as_deref(),
        Some(format!("{uploads} unchanged").as_str())
    );
    assert_eq!(label(cx, handle, "plan-count-upload"), None);

    // Prune deletes the reviewed plan's deletes once, skipping a file back in the source.
    let planned_deletes: Vec<String> = remote_paths(target)
        .into_iter()
        .filter(|path| !target.source_items.contains(path))
        .collect();
    let deletes = planned_deletes.len();
    assert_eq!(
        label(cx, handle, "plan-count-delete").as_deref(),
        Some(format!("{deletes} to delete").as_str())
    );
    // After review, one planned delete's file comes back locally; prune must leave it alone.
    let returning = "root-image.png";
    assert!(planned_deletes.iter().any(|path| path == returning));
    let returned = target.source.join(returning);
    std::fs::copy(target.archive.join(returning), &returned).unwrap();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        click(cx, handle, "sync-prune");
        let confirmation = cx.update(|cx| sync.read(cx).confirmation().map(str::to_owned));
        let confirmation = confirmation.expect("Prune asks first");
        assert!(
            confirmation.contains(&format!("Delete {deletes} remote entries")),
            "{confirmation}"
        );
        click(cx, handle, "ok");
        wait_for_run(cx, handle, &sync);
        assert_eq!(stat(cx, handle, "deleted"), (deletes - 1).to_string());
        assert_eq!(
            label(cx, handle, "run-title").as_deref(),
            Some("Prune complete")
        );
        assert_eq!(stat(cx, handle, "failed"), "0");

        // The plan is spent: a second Prune cannot re-run the same list.
        cx.update_window(handle, |_, window, _| {
            assert_eq!(window.find("sync-prune").disabled(), Some(true));
        })
        .unwrap();
        let availability = cx.update(|cx| sync.read(cx).prune_availability());
        let PruneAvailability::Disabled { reason } = availability else {
            panic!("Prune is still offered for the spent plan");
        };
        assert!(reason.contains("Run Plan again"), "{reason}");

        let mut expected: Vec<String> = target.source_items.clone();
        expected.push(returning.to_owned());
        expected.sort();
        assert_eq!(remote_paths(target), expected);
    }));
    let _ = std::fs::remove_file(&returned);
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }

    // The sync token never reaches the settings file in the clear.
    let settings = std::fs::read_to_string(data.sync().join("lockstep-settings.json")).unwrap();
    assert!(settings.contains(PROFILE_NAME));
    assert!(!settings.contains(&target.token));
}
