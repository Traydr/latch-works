//! A toast never covers a command: not the decision bar, a top bar or the activity panel, at the
//! default window and the smallest one, with the panel closed and open. A toast of one line sits in
//! the decision bar's free room, over nothing at all, and one that reports a fault stands above the
//! bar. Measured from the real layout, in the shell.

use std::cell::Cell;
use std::rc::Rc;

use crate::support::{Opened, click, frame, open_shell, scratch, start, wait_until, write_still};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, ElementId, Entity, Pixels, TestAppContext, px, size,
};
use oriel_core_paths::DataRoot;
use oriel_mode_tidy::{TidyMode, TidyPage};
use oriel_ui::{
    ARM_DELAY, ActivityJob, ModeId, ModeReporter, ShellState, Toast, ToastExt as _, Work,
};

/// A one-line toast's padding around its own body, and its rule; then a fault's.
const ONE_LINE_PADDING: (f32, f32) = (13., 7.);
const FAULT_PADDING: (f32, f32) = (17., 15.);

fn bounds(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    id: impl Into<ElementId>,
) -> Option<Bounds<Pixels>> {
    let id = id.into();
    cx.update_window(handle, |_, window, _| {
        window.try_find(id.clone()).map(|found| found.bounds())
    })
    .unwrap()
}

/// How far apart two rectangles are: the larger of the two axes' gaps, below zero if they overlap.
fn clearance(a: Bounds<Pixels>, b: Bounds<Pixels>) -> f32 {
    let across = f32::from(a.left().max(b.left()) - a.right().min(b.right()));
    let down = f32::from(a.top().max(b.top()) - a.bottom().min(b.bottom()));
    across.max(down)
}

fn the_toast(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    padding: (f32, f32),
) -> Bounds<Pixels> {
    let body = bounds(cx, handle, "toast").expect("the toast is drawn");
    let (x, y) = (px(padding.0), px(padding.1));
    Bounds::new(
        body.origin - gpui_kit::point(x, y),
        size(body.size.width + x * 2., body.size.height + y * 2.),
    )
}

fn check(
    cx: &mut TestAppContext,
    handle: AnyWindowHandle,
    case: &str,
    padding: (f32, f32),
    commands: &[&'static str],
) -> Bounds<Pixels> {
    // What the toast stands on is drawn and measured, and the toast has stayed put since.
    let still = Cell::new((None, 0));
    wait_until(cx, handle, "the toast to settle", |cx| {
        let drawn = bounds(cx, handle, "toast");
        let ready = drawn.is_some()
            && commands
                .iter()
                .all(|command| bounds(cx, handle, *command).is_some());
        let (last, frames) = still.get();
        let frames = if ready && last == drawn {
            frames + 1
        } else {
            0
        };
        still.set((drawn, frames));
        frames >= 3
    });
    let toast = the_toast(cx, handle, padding);
    let viewport = cx
        .update_window(handle, |_, window, _| window.viewport_size())
        .unwrap();
    assert!(toast.right() <= viewport.width, "{case}: {toast:?}");
    assert!(
        toast.right() > viewport.width / 2.,
        "{case}: the toast is on the right: {toast:?}"
    );
    for command in commands {
        let found = bounds(cx, handle, *command);
        let found = found.unwrap_or_else(|| panic!("{case}: {command} is drawn"));
        let gap = clearance(toast, found);
        eprintln!("{case}: {command} clears the toast by {gap:.0} px");
        assert!(
            gap >= 6.,
            "{case}: {command} at {found:?}, toast at {toast:?}"
        );
    }
    toast
}

/// The end of a run puts a toast's Undo where the panel's Stop was, so a click just too late for
/// Stop must not undo the run.
#[gpui_kit::test]
fn a_toast_action_ignores_clicks_just_after_it_appears(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("toast-arm").join("data")).unwrap();
    start(cx, &data);
    let Opened { handle, .. } = open_shell(cx, &data);
    let undone = Rc::new(Cell::new(0));
    let counted = undone.clone();
    cx.update_window(handle, |_, window, cx| {
        let toast = Toast::done("Shrank 6 videos").action("Undo", move |_, _| {
            counted.set(counted.get() + 1);
        });
        window.show_toast(toast, cx);
    })
    .unwrap();
    // It fades in first, well inside the time it ignores clicks.
    wait_until(cx, handle, "the toast to show", |cx| {
        cx.update_window(handle, |_, window, _| {
            window
                .try_find("toast-action")
                .is_some_and(|action| action.visible())
        })
        .unwrap()
    });
    click(cx, handle, "toast-action");
    assert_eq!(undone.get(), 0, "a click as it appears does nothing");
    cx.executor().advance_clock(ARM_DELAY);
    frame(cx, handle);
    click(cx, handle, "toast-action");
    assert_eq!(undone.get(), 1, "a click once it has settled is an Undo");
}

/// When a toast takes the place of the open panel, its action keeps out of the column Pause and
/// Stop were just in, where a pointer may still be resting, aimed at them.
#[gpui_kit::test]
fn a_toast_after_the_panel_keeps_its_action_off_pause_and_stop(cx: &mut TestAppContext) {
    let data = DataRoot::at(scratch("toast-panel").join("data")).unwrap();
    start(cx, &data);
    let Opened { handle, shell, .. } = open_shell(cx, &data);
    let state = cx.update(|cx| shell.read(cx).state().clone());
    let jobs = cx.update(|cx| state.read(cx).jobs().clone());
    publish(
        cx,
        &state,
        ModeId::View,
        vec![
            ActivityJob::new("one", "Pretend job")
                .counts(1, 2)
                .pausable(true)
                .stoppable(true),
        ],
    );
    jobs.update(cx, |jobs, cx| jobs.set_open(true, cx));
    let pause_id = oriel_ui::activity::job_element_id(ModeId::View, "one", "pause");
    wait_until(cx, handle, "the panel's Pause", |cx| {
        bounds(cx, handle, pause_id.clone()).is_some()
    });
    let pause = bounds(cx, handle, pause_id).unwrap();

    publish(cx, &state, ModeId::View, Vec::new());
    cx.update_window(handle, |_, window, cx| {
        let toast = Toast::done("Shrank 6 videos").action("Undo", |_, _| {});
        window.show_toast(toast, cx);
    })
    .unwrap();
    wait_until(cx, handle, "the toast", |cx| {
        bounds(cx, handle, "toast-action").is_some()
    });
    frame(cx, handle);
    let undo = bounds(cx, handle, "toast-action").unwrap();
    assert!(
        undo.right() < pause.left(),
        "Undo {undo:?} reaches the column of Pause {pause:?}"
    );
}

#[gpui_kit::test]
fn a_toast_stands_clear_of_every_command(cx: &mut TestAppContext) {
    let root = scratch("toast");
    let archive = root.join("archive");
    // Byte-identical copies, the quickest set to find, so Duplicates shows its decision bar.
    write_still(&archive.join("one/copy.webp"), 40);
    std::fs::create_dir_all(archive.join("two")).unwrap();
    std::fs::copy(archive.join("one/copy.webp"), archive.join("two/copy.webp")).unwrap();
    let data = DataRoot::at(root.join("data")).unwrap();
    start(cx, &data);
    let Opened { handle, shell, .. } = open_shell(cx, &data);
    let tidy = cx.update(|cx| shell.read(cx).mode::<TidyMode>().clone());
    let state = cx.update(|cx| shell.read(cx).state().clone());
    state.update(cx, |state, cx| state.go(ModeId::Tidy, cx));
    wait_until(cx, handle, "Tidy's engine", |cx| {
        tidy.read_with(cx, |tidy, cx| tidy.state().read(cx).is_ready())
    });
    cx.update_window(handle, |_, window, cx| {
        tidy.update(cx, |tidy, cx| tidy.add_folder(archive.clone(), window, cx));
    })
    .unwrap();
    wait_until(cx, handle, "Tidy's scan", |cx| {
        tidy.read_with(cx, |tidy, cx| {
            tidy.state()
                .read(cx)
                .root()
                .is_some_and(|root| root.last_scan_at.is_some())
        })
    });
    let tidy_state = cx.update(|cx| tidy.read(cx).state().clone());
    tidy_state.update(cx, |state, cx| state.go(TidyPage::Duplicates, cx));
    wait_until(cx, handle, "the decision bar", |cx| {
        bounds(cx, handle, "duplicates-decide").is_some()
    });
    let bar: &[&'static str] = &[
        "duplicates-decide",
        "duplicates-keep-every",
        "duplicates-skip",
        "toggle-sidebar",
    ];
    // The indicator in the bar's free room keeps its spinner and chevron whole, at any count.
    for (done, total) in [(10, 100), (1000, 2000)] {
        publish(
            cx,
            &state,
            ModeId::Sync,
            vec![
                ActivityJob::new("one", "Pretend job").counts(done, total),
                ActivityJob::new("two", "Pretend job").counts(1, 2),
            ],
        );
        for (width, height) in [(1320., 860.), (1130., 760.), (960., 640.)] {
            cx.simulate_window_resize(handle, size(px(width), px(height)));
            wait_until(cx, handle, "the indicator", |cx| {
                bounds(cx, handle, "activity-indicator").is_some()
            });
            frame(cx, handle);
            let pill = bounds(cx, handle, "activity-indicator").unwrap();
            let chevron = bounds(cx, handle, "activity-indicator-open").unwrap();
            assert!(
                chevron.right() <= pill.right(),
                "{done} of {total} at {width}: {chevron:?} leaves {pill:?}"
            );
        }
    }
    publish(cx, &state, ModeId::Sync, Vec::new());

    for (width, height) in [(1320., 860.), (960., 640.)] {
        cx.simulate_window_resize(handle, size(px(width), px(height)));
        frame(cx, handle);
        let case = format!("{width}x{height}");
        let one_line = ONE_LINE_PADDING;
        cx.update_window(handle, |_, window, cx| {
            window.show_toast(
                Toast::done("Kept 1 of 2").stays().action("Undo", |_, _| {}),
                cx,
            );
        })
        .unwrap();
        // In the decision bar's free room, over nothing: not a tile, whatever the grid shows.
        let toast = check(cx, handle, &case, one_line, bar);
        let band = bounds(cx, handle, "duplicates-decision-bar").unwrap();
        assert!(
            toast.top() >= band.top() && toast.bottom() <= band.bottom(),
            "{case}: {toast:?} leaves the bar {band:?}"
        );

        // The activity panel, closed and then open with more jobs than it shows at once.
        let jobs = cx.update(|cx| state.read(cx).jobs().clone());
        publish(
            cx,
            &state,
            ModeId::Sync,
            vec![
                ActivityJob::new("one", "Pretend job")
                    .counts(1, 4)
                    .stoppable(true),
            ],
        );
        frame(cx, handle);
        check(
            cx,
            handle,
            &format!("{case} with the indicator"),
            one_line,
            &[bar, &["activity-indicator"]].concat(),
        );
        let many = (0..8)
            .map(|job| {
                ActivityJob::new(format!("job-{job}"), "Pretend job")
                    .counts(1, 4)
                    .stoppable(true)
            })
            .collect();
        publish(cx, &state, ModeId::Sync, many);
        jobs.update(cx, |jobs, cx| jobs.set_open(true, cx));
        frame(cx, handle);
        let panel_commands = &[bar, &["activity-panel", "activity-panel-close"]].concat();
        check(
            cx,
            handle,
            &format!("{case} with the panel"),
            one_line,
            panel_commands,
        );

        // A fault says why, so it takes more room: it stands above the bar and on the panel, and
        // still reaches neither the top bar nor anything it stands on.
        cx.update_window(handle, |_, window, cx| {
            window.show_toast(
                Toast::error("Undo did not finish")
                    .detail("One file changed since the scan, so it was left where it is."),
                cx,
            );
        })
        .unwrap();
        let toast = check(
            cx,
            handle,
            &format!("{case} fault with the panel"),
            FAULT_PADDING,
            panel_commands,
        );
        let panel = bounds(cx, handle, "activity-panel").unwrap();
        assert!(
            toast.bottom() <= panel.top(),
            "{case}: {toast:?} over {panel:?}"
        );
        assert!(
            toast.top() >= px(60.),
            "{case}: {toast:?} reaches the top bar"
        );
        publish(cx, &state, ModeId::Sync, Vec::new());
        jobs.update(cx, |jobs, cx| jobs.set_open(false, cx));
        cx.update_window(handle, |_, window, cx| window.dismiss_toast(cx))
            .unwrap();
        frame(cx, handle);
    }
}

/// Reports `jobs` as `mode`'s, as the mode would.
fn publish(
    cx: &mut TestAppContext,
    state: &Entity<ShellState>,
    mode: ModeId,
    jobs: Vec<ActivityJob>,
) {
    let work = Work {
        jobs,
        ..Work::default()
    };
    cx.update(|cx| ModeReporter::new(state, mode).report(work, cx));
}
