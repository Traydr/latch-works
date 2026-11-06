//! Start-up states for checking the shell in a real window, where scripted input is not
//! allowed (plan 063's measurements run the same way):
//!
//! - `ORIEL_ACTIVITY=tidy=0.4,sync=working` reports work for modes at start, to see the
//!   switcher's ring and dot and the Dock's progress. While a mode reports progress, quitting
//!   waits for it, so ⌘Q twice quits.
//! - `ORIEL_SETTINGS=general` (or `view`, `tidy`, `sync`) opens Settings at that section.
//! - `ORIEL_ABOUT=1` opens the About dialog, to see the licences a bundle lists.
//! - `ORIEL_ACTIVITY_PANEL=1` opens the activity panel whenever work runs, to see it without
//!   a click.
//! - `ORIEL_ACTIVITY_JOBS=<n>` puts that many pretend jobs on the activity panel, to see it and
//!   what stands on it without real work.
//! - `ORIEL_SCRIPT=<steps>` plays input through the window's own event path once it has drawn, so a
//!   state that needs the pointer or a key can be reached and captured: hover, focus, tooltips,
//!   live scrolling. Steps are split by `;`: `wait <ms>`, `move <x>,<y>`, `click <x>,<y>`,
//!   `scroll <x>,<y>,<dy>` and `key <keystroke>`, such as `key tab` or `key cmd-z`. Clicks and keys
//!   do what the owner's would, so point them only at a scratch data folder.
//! - `ORIEL_TOAST=<words>` shows a toast with Undo that stays, once the window has drawn, to see
//!   and measure where it sits. `ORIEL_TOAST_DETAIL=<words>` gives it a second line, and
//!   `ORIEL_TOAST_FAULT=1` makes it a fault, which keeps its second line in sight.

use std::time::Duration;

use gpui_kit::{
    App, Context, Entity, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PlatformInput, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase, Window, point,
    px,
};
use oriel_ui::{ActivityJob, JobState, ModeActivity, ModeId, SettingsSection, ShellState, Toast};

pub const ACTIVITY_VARIABLE: &str = "ORIEL_ACTIVITY";
pub const SETTINGS_VARIABLE: &str = "ORIEL_SETTINGS";
pub const ABOUT_VARIABLE: &str = "ORIEL_ABOUT";
pub const ACTIVITY_PANEL_VARIABLE: &str = "ORIEL_ACTIVITY_PANEL";
pub const ACTIVITY_JOBS_VARIABLE: &str = "ORIEL_ACTIVITY_JOBS";
pub const SCRIPT_VARIABLE: &str = "ORIEL_SCRIPT";
pub const TOAST_VARIABLE: &str = "ORIEL_TOAST";
pub const TOAST_DETAIL_VARIABLE: &str = "ORIEL_TOAST_DETAIL";

/// Whether `ORIEL_ABOUT` asks for the About dialog at start.
pub fn about_from_environment() -> bool {
    std::env::var(ABOUT_VARIABLE).is_ok_and(|value| value == "1")
}

/// Whether `ORIEL_ACTIVITY_PANEL` asks for the activity panel open while work runs.
pub fn activity_panel_from_environment() -> bool {
    std::env::var(ACTIVITY_PANEL_VARIABLE).is_ok_and(|value| value == "1")
}

/// The toast `ORIEL_TOAST` asks for, if any.
pub fn toast_from_environment() -> Option<Toast> {
    let message = std::env::var(TOAST_VARIABLE).ok()?;
    let toast = if std::env::var_os("ORIEL_TOAST_FAULT").is_some() {
        Toast::error(message)
    } else {
        Toast::done(message).stays().action("Undo", |_, _| {})
    };
    Some(match std::env::var(TOAST_DETAIL_VARIABLE) {
        Ok(detail) => toast.detail(detail),
        Err(_) => toast,
    })
}

/// One step of `ORIEL_SCRIPT`.
#[derive(Clone, Debug, PartialEq)]
enum Step {
    Wait(u64),
    Move(f32, f32),
    Click(f32, f32),
    DoubleClick(f32, f32),
    Scroll(f32, f32, f32),
    Key(String),
}

/// `wait 500; move 10,20; click 10,20; double 10,20; scroll 10,20,-300; key tab` as steps; anything it cannot
/// read is left out.
fn parse_script(text: &str) -> Vec<Step> {
    text.split(';')
        .filter_map(|step| {
            let (verb, rest) = step.trim().split_once(' ')?;
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
                ("key", _) => Some(Step::Key(rest.trim().to_owned())),
                _ => None,
            }
        })
        .collect()
}

/// Plays `ORIEL_SCRIPT`, a step at a time with a frame between them, if it is set.
pub fn start_script<T: 'static>(window: &mut Window, cx: &mut Context<T>) {
    let Ok(script) = std::env::var(SCRIPT_VARIABLE) else {
        return;
    };
    let steps = parse_script(&script);
    cx.spawn_in(window, async move |_, cx| {
        for step in steps {
            let wait = match &step {
                Step::Wait(ms) => *ms,
                _ => 120,
            };
            cx.background_executor()
                .timer(Duration::from_millis(wait))
                .await;
            let played = cx.update(|window, cx| play(&step, window, cx));
            if played.is_err() {
                return;
            }
        }
    })
    .detach();
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
        Step::Wait(_) => {}
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
        Step::Key(keys) => {
            // GPUI reads a keystroke only from a `'static` string; a script is short and plays once.
            let keys: &'static str = Box::leak(keys.clone().into_boxed_str());
            if let Ok(keystroke) = Keystroke::parse(keys) {
                window.dispatch_keystroke(keystroke.clone(), cx);
                // A real key comes back up, and a button presses on Space's or Enter's way up.
                window.dispatch_event(PlatformInput::KeyUp(gpui_kit::KeyUpEvent { keystroke }), cx);
            }
        }
    }
    window.refresh();
}

/// Applies whichever of the variables are set.
pub fn apply_from_environment(state: &Entity<ShellState>, cx: &mut App) {
    if let Some(count) = std::env::var(ACTIVITY_JOBS_VARIABLE)
        .ok()
        .and_then(|count| count.parse::<u64>().ok())
    {
        // The panel's kinds of row, in turn: running, paused, in the background, queued.
        let jobs = (1..=count)
            .map(|job| {
                let state = match job % 4 {
                    1 => JobState::Running,
                    2 => JobState::Paused,
                    3 => JobState::Background,
                    _ => JobState::Queued,
                };
                ActivityJob::new(format!("check-{job}"), format!("Pretend job {job}"))
                    .state(state)
                    .counts(job * 10, 100)
                    .pausable(state != JobState::Queued)
                    .stoppable(true)
            })
            .collect();
        let activity = state.read(cx).jobs().clone();
        activity.update(cx, |activity, cx| {
            activity.set_jobs(ModeId::Sync, jobs, cx);
        });
    }
    if let Ok(activity) = std::env::var(ACTIVITY_VARIABLE) {
        for (mode, activity) in parse_activity(&activity) {
            state.update(cx, |state, cx| state.set_activity(mode, Some(activity), cx));
        }
    }
    if let Some(section) = std::env::var(SETTINGS_VARIABLE)
        .ok()
        .and_then(|key| parse_section(&key))
    {
        state.update(cx, |state, cx| state.open_settings(section, cx));
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

fn parse_section(key: &str) -> Option<SettingsSection> {
    SettingsSection::ALL
        .into_iter()
        .find(|section| section.key() == key.trim())
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
        assert_eq!(parse_section("general"), Some(SettingsSection::General));
        assert_eq!(parse_section("sandbox"), None);
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
