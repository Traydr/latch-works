//! What a launch asks of the shell for a check in a real window:
//!
//! - `ORIEL_ACTIVITY=tidy=0.4,sync=working` reports work for modes at start, to see the
//!   switcher's ring and dot and the Dock's progress. A mode with progress holds quitting, so ⌘Q
//!   twice quits.
//! - `ORIEL_ACTIVITY_JOBS=<n>` puts that many pretend jobs on the activity panel, in turn running,
//!   paused, in the background and queued, to see it and what stands on it without real work.
//! - `ORIEL_ACTIVITY_PANEL=1` opens the activity panel whenever work runs, to see it without a
//!   click.
//! - `ORIEL_WELCOME=1` shows the first start's welcome in a sandboxed run.
//! - `ORIEL_TOOLS_KEEP_RUNNING=1` lets tools run on when their job is paused, as they do where
//!   they cannot be suspended, to see "Pausing after …" on a machine where they can.
//! - `ORIEL_SCRIPT=<steps>` plays input through the window's own event path once it has drawn, so
//!   any state the owner reaches with the pointer or the keys can be reached and captured. Steps
//!   are split by `;`:
//!   - `wait <ms>`, and `idle`, which waits until no mode reports work (a folder listed, a scan
//!     and its analysis done);
//!   - `move <x>,<y>`, `click <x>,<y>`, `double <x>,<y>` and `scroll <x>,<y>,<dy>`;
//!   - `key <keystroke>`, such as `key tab`, `key cmd-z` or `key ?`;
//!   - `action <name>`, an action by its name, such as `action view::OpenFolder` or
//!     `action gallery::ActivateSelected`, sent where a key would go;
//!   - `toast <words>` shows a toast with Undo that stays, to see and measure where it sits, and
//!     `fault <words>` a fault, which keeps its second line in sight; `| <words>` after either
//!     gives it a second line.
//!
//!   Clicks, keys and actions do what the owner's would, so point them only at a scratch data
//!   folder.

use std::time::Duration;

use futures::StreamExt as _;
use gpui_kit::{
    App, Context, Entity, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PlatformInput, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase, Window, point,
    px,
};
use oriel_launch::Variables;
use oriel_ui::{
    ActivityJob, JobState, ModeActivity, ModeId, ModeMap, ModeReporter, ShellState, Toast,
    ToastExt as _, Work,
};

const ACTIVITY: &str = "ORIEL_ACTIVITY";
const ACTIVITY_JOBS: &str = "ORIEL_ACTIVITY_JOBS";
const ACTIVITY_PANEL: &str = "ORIEL_ACTIVITY_PANEL";
const WELCOME: &str = "ORIEL_WELCOME";
const SCRIPT: &str = "ORIEL_SCRIPT";
pub(crate) const TOOLS_KEEP_RUNNING: &str = "ORIEL_TOOLS_KEEP_RUNNING";

/// How long the script waits between steps that are input, as a person's would.
const BETWEEN_STEPS: Duration = Duration::from_millis(120);

/// What a launch asks of the shell for a check.
#[derive(Clone, Debug, Default)]
pub struct ShellChecks {
    activity: Vec<(ModeId, ModeActivity)>,
    activity_jobs: u64,
    pub(crate) activity_panel: bool,
    pub(crate) welcome: bool,
    script: Vec<Step>,
}

impl ShellChecks {
    pub fn from_variables(launch: &Variables) -> Self {
        Self {
            activity: launch.get(ACTIVITY).map(parse_activity).unwrap_or_default(),
            activity_jobs: launch.parse(ACTIVITY_JOBS).unwrap_or(0),
            activity_panel: launch.is_on(ACTIVITY_PANEL),
            welcome: launch.is_on(WELCOME),
            script: launch.get(SCRIPT).map(parse_script).unwrap_or_default(),
        }
    }
}

/// One step of `ORIEL_SCRIPT`.
#[derive(Clone, Debug, PartialEq)]
enum Step {
    Wait(u64),
    Idle,
    Move(f32, f32),
    Click(f32, f32),
    DoubleClick(f32, f32),
    Scroll(f32, f32, f32),
    Key(String),
    Action(String),
    Toast {
        fault: bool,
        message: String,
        detail: Option<String>,
    },
}

/// `wait 500; idle; move 10,20; click 10,20; double 10,20; scroll 10,20,-300; key tab;
/// action view::Refresh; toast Moved | Undo in History` as steps; a step it cannot read is left
/// out, with a warning.
fn parse_script(text: &str) -> Vec<Step> {
    text.split(';')
        .map(str::trim)
        .filter(|step| !step.is_empty())
        .filter_map(|step| {
            let parsed = parse_step(step);
            if parsed.is_none() {
                log::warn!("ORIEL_SCRIPT cannot read the step {step:?}");
            }
            parsed
        })
        .collect()
}

fn parse_step(step: &str) -> Option<Step> {
    if step == "idle" {
        return Some(Step::Idle);
    }
    let (verb, rest) = step.split_once(' ')?;
    let rest = rest.trim();
    let numbers: Vec<f32> = rest
        .split(',')
        .filter_map(|number| number.trim().parse().ok())
        .collect();
    match (verb, numbers.as_slice()) {
        ("wait", [ms]) => Some(Step::Wait(*ms as u64)),
        ("move", [x, y]) => Some(Step::Move(*x, *y)),
        ("click", [x, y]) => Some(Step::Click(*x, *y)),
        ("double", [x, y]) => Some(Step::DoubleClick(*x, *y)),
        ("scroll", [x, y, dy]) => Some(Step::Scroll(*x, *y, *dy)),
        ("key", _) => Some(Step::Key(rest.to_owned())),
        ("action", _) => Some(Step::Action(rest.to_owned())),
        ("toast" | "fault", _) => {
            let (message, detail) = match rest.split_once('|') {
                Some((message, detail)) => (message, Some(detail.trim().to_owned())),
                None => (rest, None),
            };
            Some(Step::Toast {
                fault: verb == "fault",
                message: message.trim().to_owned(),
                detail,
            })
        }
        _ => None,
    }
}

/// Plays the script, a step at a time, once the window has drawn.
pub(crate) fn play_script<T: 'static>(
    checks: &ShellChecks,
    shell: &Entity<ShellState>,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    if checks.script.is_empty() {
        return;
    }
    let steps = checks.script.clone();
    let shell = shell.clone();
    cx.spawn_in(window, async move |_, cx| {
        for step in steps {
            match &step {
                Step::Wait(ms) => {
                    cx.background_executor()
                        .timer(Duration::from_millis(*ms))
                        .await;
                    continue;
                }
                Step::Idle => {
                    if !wait_until_idle(&shell, cx).await {
                        return;
                    }
                    continue;
                }
                _ => cx.background_executor().timer(BETWEEN_STEPS).await,
            }
            if cx.update(|window, cx| play(&step, window, cx)).is_err() {
                return;
            }
        }
    })
    .detach();
}

/// Waits until no mode reports work and the activity panel is empty, woken by each change.
/// Whether the window is still there.
async fn wait_until_idle(
    shell: &Entity<ShellState>,
    cx: &mut gpui_kit::AsyncWindowContext,
) -> bool {
    let (changed, mut changes) = futures::channel::mpsc::unbounded::<()>();
    let watching = cx.update(|_, cx| {
        let jobs = shell.read(cx).jobs().clone();
        let on_jobs = changed.clone();
        [
            cx.observe(shell, move |_, _| {
                changed.unbounded_send(()).ok();
            }),
            cx.observe(&jobs, move |_, _| {
                on_jobs.unbounded_send(()).ok();
            }),
        ]
    });
    let Ok(_watching) = watching else {
        return false;
    };
    loop {
        let idle = cx.update(|_, cx| {
            let state = shell.read(cx);
            state.is_idle() && state.jobs().read(cx).is_idle()
        });
        match idle {
            Ok(true) => return true,
            Ok(false) => {}
            Err(_) => return false,
        }
        if changes.next().await.is_none() {
            return false;
        }
    }
}

fn play(step: &Step, window: &mut Window, cx: &mut App) {
    let at = |x: f32, y: f32| point(px(x), px(y));
    let modifiers = Modifiers::default();
    let moved = |position| {
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers,
        })
    };
    match step {
        Step::Wait(_) | Step::Idle => {}
        Step::Move(x, y) => {
            window.dispatch_event(moved(at(*x, *y)), cx);
        }
        Step::Click(x, y) | Step::DoubleClick(x, y) => {
            let position = at(*x, *y);
            let clicks = if matches!(step, Step::DoubleClick(..)) {
                2
            } else {
                1
            };
            window.dispatch_event(moved(position), cx);
            for click_count in 1..=clicks {
                window.dispatch_event(
                    PlatformInput::MouseDown(MouseDownEvent {
                        button: MouseButton::Left,
                        position,
                        modifiers,
                        click_count,
                        first_mouse: false,
                    }),
                    cx,
                );
                window.dispatch_event(
                    PlatformInput::MouseUp(MouseUpEvent {
                        button: MouseButton::Left,
                        position,
                        modifiers,
                        click_count,
                    }),
                    cx,
                );
            }
        }
        Step::Scroll(x, y, dy) => {
            let position = at(*x, *y);
            window.dispatch_event(moved(position), cx);
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position,
                    delta: ScrollDelta::Pixels(point(px(0.), px(*dy))),
                    modifiers,
                    touch_phase: TouchPhase::Moved,
                    source: ScrollSource::default(),
                }),
                cx,
            );
        }
        Step::Action(name) => match cx.build_action(name, None) {
            Ok(action) => window.dispatch_action(action, cx),
            Err(error) => log::warn!("ORIEL_SCRIPT has no action {name}: {error}"),
        },
        Step::Toast {
            fault,
            message,
            detail,
        } => {
            let toast = if *fault {
                Toast::error(message.clone())
            } else {
                Toast::done(message.clone())
                    .stays()
                    .action("Undo", |_, _| {})
            };
            let toast = match detail {
                Some(detail) => toast.detail(detail.clone()),
                None => toast,
            };
            window.show_toast(toast, cx);
        }
        Step::Key(keys) => {
            // GPUI reads a keystroke only from a `'static` string; a script is short and plays once.
            let keys: &'static str = Box::leak(keys.clone().into_boxed_str());
            match Keystroke::parse(keys) {
                Ok(keystroke) => {
                    window.dispatch_keystroke(keystroke.clone(), cx);
                    // A real key comes back up, and a button presses on Space's or Enter's way up.
                    window.dispatch_event(
                        PlatformInput::KeyUp(gpui_kit::KeyUpEvent { keystroke }),
                        cx,
                    );
                }
                Err(error) => log::warn!("ORIEL_SCRIPT cannot read the key {keys}: {error}"),
            }
        }
    }
    window.refresh();
}

/// Reports the pretend work the checks ask for.
pub(crate) fn apply(checks: &ShellChecks, shell: &Entity<ShellState>, cx: &mut App) {
    if checks.activity.is_empty() && checks.activity_jobs == 0 {
        return;
    }
    let mut work: ModeMap<Work> = ModeMap::default();
    for (mode, activity) in &checks.activity {
        work[*mode].shown = Some(*activity);
        work[*mode].holds_quit = matches!(activity, ModeActivity::Progress(_));
    }
    for job in 1..=checks.activity_jobs {
        // The panel's kinds of row, in turn: running, paused, in the background, queued.
        let state = match job % 4 {
            1 => JobState::Running,
            2 => JobState::Paused,
            3 => JobState::Background,
            _ => JobState::Queued,
        };
        // Sync's, which reports nothing until it runs, so they stay.
        work[ModeId::Sync].jobs.push(
            ActivityJob::new(format!("check-{job}"), format!("Pretend job {job}"))
                .state(state)
                .counts(job * 10, 100)
                .pausable(state != JobState::Queued)
                .stoppable(true),
        );
    }
    for (mode, work) in work.iter() {
        ModeReporter::new(shell, mode).report(work.clone(), cx);
    }
}

/// `tidy=0.4,sync=working` as each mode's work; anything it cannot read is left out.
fn parse_activity(text: &str) -> Vec<(ModeId, ModeActivity)> {
    text.split(',')
        .filter_map(|entry| {
            let (mode, value) = entry.trim().split_once('=')?;
            let mode = ModeId::from_key(mode.trim())?;
            let activity = match value.trim() {
                "working" => ModeActivity::Working,
                ratio => ModeActivity::Progress(ratio.parse().ok()?),
            };
            Some((mode, activity))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_modes_work() {
        assert_eq!(
            parse_activity("tidy=0.4, sync=working, view=lots, frame=1"),
            [
                (ModeId::Tidy, ModeActivity::Progress(0.4)),
                (ModeId::Sync, ModeActivity::Working)
            ]
        );
    }

    #[test]
    fn reads_a_script_and_leaves_out_what_it_cannot() {
        assert_eq!(
            parse_script("wait 500; move 10,20; click 1,2; scroll 3,4,-300; key cmd-z; dance 1"),
            [
                Step::Wait(500),
                Step::Move(10., 20.),
                Step::Click(1., 2.),
                Step::Scroll(3., 4., -300.),
                Step::Key("cmd-z".into()),
            ]
        );
    }
}
