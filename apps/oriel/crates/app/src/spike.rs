//! The shell's measurements (plan 063): mode switches and Settings, set up by the launch's
//! variables as View's and the Library's spikes are.
//!
//! With `ORIEL_SPIKE_SHELL` naming a file, the shell rests once the window has drawn
//! (`ORIEL_SPIKE_REST_MS`, 2 s by default), then steps through ⌘2, ⌘3 and ⌘1 twice over, so
//! each mode shows for the first time and then again, and then Settings at each section, and
//! closes it. Each step writes one JSON line to the file:
//!
//! - `to_frame_ms`: from the switch to the end of the first frame that draws it, which includes
//!   the wait for that frame's turn;
//! - `frame_ms`: from the shell's render of it to the end of that frame;
//! - `cpu_ms`: the process's CPU time over the same span as `to_frame_ms`;
//! - `resident_mb` and `footprint_mb`: the process's memory after a rest on that screen.
//!
//! `ORIEL_SPIKE_QUIT=1` quits after the last step. `ORIEL_OPEN`, `ORIEL_TIDY_ROOT` and
//! `ORIEL_TIDY_PAGE` set up what the modes show.

use std::time::{Duration, Instant};

use futures::channel::oneshot;
use gpui_kit::{Context, Window};
use oriel_launch::{Variables, variables};
use oriel_ui::measure::{SpikeLog, memory_fields, process_cpu_ms};
use oriel_ui::{ModeId, SettingsSection};

use crate::shell::Shell;

const SPIKE_SHELL: &str = "ORIEL_SPIKE_SHELL";

/// What the window shows at a step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Screen {
    Mode(ModeId),
    Settings(SettingsSection),
}

impl Screen {
    fn label(self) -> String {
        match self {
            Screen::Mode(mode) => mode.key().to_owned(),
            Screen::Settings(SettingsSection::General) => "settings-general".to_owned(),
            Screen::Settings(SettingsSection::Mode(mode)) => format!("settings-{}", mode.key()),
        }
    }
}

const STEPS: [Screen; 11] = [
    Screen::Mode(ModeId::Tidy),
    Screen::Mode(ModeId::Sync),
    Screen::Mode(ModeId::View),
    Screen::Mode(ModeId::Tidy),
    Screen::Mode(ModeId::Sync),
    Screen::Mode(ModeId::View),
    Screen::Settings(SettingsSection::General),
    Screen::Settings(SettingsSection::Mode(ModeId::View)),
    Screen::Settings(SettingsSection::Mode(ModeId::Tidy)),
    Screen::Settings(SettingsSection::Mode(ModeId::Sync)),
    Screen::Mode(ModeId::View),
];

/// A step waiting for the frame that draws it.
struct Pending {
    screen: Screen,
    rendered: Option<Instant>,
    done: oneshot::Sender<(Instant, Instant)>,
}

pub(crate) struct ShellSpike {
    log: SpikeLog,
    pending: Option<Pending>,
}

impl ShellSpike {
    /// The spike, when `ORIEL_SPIKE_SHELL` names a file it can write.
    pub(crate) fn open(spikes: &Variables) -> Option<Self> {
        let log = SpikeLog::open(spikes.get(SPIKE_SHELL)?)?;
        Some(Self { log, pending: None })
    }

    /// Called as the shell renders `drawn`: the frame that draws a pending step ends at the
    /// next frame's start.
    pub(crate) fn on_render(&mut self, drawn: Screen, window: &mut Window) {
        let Some(pending) = &mut self.pending else {
            return;
        };
        if pending.screen != drawn || pending.rendered.is_some() {
            return;
        }
        let rendered = Instant::now();
        pending.rendered = Some(rendered);
        let Some(pending) = self.pending.take() else {
            return;
        };
        window.on_next_frame(move |_, _| {
            pending.done.send((rendered, Instant::now())).ok();
        });
    }
}

/// Runs the steps on `shell`'s window, once it has drawn and rested.
pub(crate) fn start(spikes: &Variables, window: &mut Window, cx: &mut Context<Shell>) {
    let rest = Duration::from_millis(spikes.parse(variables::SPIKE_REST_MS).unwrap_or(2_000));
    let quit = spikes.is_on(variables::SPIKE_QUIT);
    cx.spawn_in(window, async move |this, cx| {
        cx.background_executor().timer(rest).await;
        for screen in STEPS {
            let (done, drawn) = oneshot::channel();
            let switched = this.update_in(cx, |shell, window, cx| {
                let spike = shell.spike.as_mut()?;
                spike.pending = Some(Pending {
                    screen,
                    rendered: None,
                    done,
                });
                let (switched, cpu) = (Instant::now(), process_cpu_ms());
                let state = shell.state().clone();
                state.update(cx, |state, cx| match screen {
                    Screen::Mode(mode) => state.go(mode, cx),
                    Screen::Settings(section) => state.open_settings(section, cx),
                });
                window.refresh();
                Some((switched, cpu))
            });
            let Ok(Some((switched, cpu_before))) = switched else {
                return;
            };
            let Ok((rendered, framed)) = drawn.await else {
                return;
            };
            let cpu = process_cpu_ms() - cpu_before;
            cx.background_executor().timer(rest.min(Duration::from_secs(1))).await;
            let memory = memory_fields();
            this.update(cx, |shell, _| {
                if let Some(spike) = &mut shell.spike {
                    spike.log.write(&format!(
                        r#""event":"{}","to_frame_ms":{:.1},"frame_ms":{:.1},"cpu_ms":{cpu:.1},{memory}"#,
                        screen.label(),
                        (framed - switched).as_secs_f64() * 1e3,
                        (framed - rendered).as_secs_f64() * 1e3,
                    ));
                }
            })
            .ok();
        }
        if quit {
            cx.update(|_, cx| cx.quit()).ok();
        }
    })
    .detach();
}
