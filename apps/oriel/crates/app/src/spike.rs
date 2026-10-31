//! The shell's measurements (plan 063): mode switches and Settings, run by environment variables
//! as View's and the Library's spikes are, since this Mac allows no scripted input.
//!
//! With [`LOG_VARIABLE`] naming a file, the shell rests once the window has drawn
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

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::time::{Duration, Instant};

use futures::channel::oneshot;
use gpui_kit::{Context, Window};
use oriel_ui::{ModeId, SettingsSection};

use crate::shell::Shell;

pub const LOG_VARIABLE: &str = "ORIEL_SPIKE_SHELL";
const REST_VARIABLE: &str = "ORIEL_SPIKE_REST_MS";
const QUIT_VARIABLE: &str = "ORIEL_SPIKE_QUIT";

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
    log: File,
    pending: Option<Pending>,
}

fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl ShellSpike {
    /// The spike, when [`LOG_VARIABLE`] names a file it can write; it starts at the first
    /// render.
    pub(crate) fn from_environment() -> Option<Self> {
        let path = variable(LOG_VARIABLE)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| log::error!("cannot open the spike log {path}: {error}"))
            .ok()?;
        Some(Self { log, pending: None })
    }

    fn write(&mut self, fields: &str) {
        if let Err(error) = writeln!(self.log, "{{{fields}}}") {
            log::error!("cannot write the spike log: {error}");
        }
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
pub(crate) fn start(window: &mut Window, cx: &mut Context<Shell>) {
    let rest = Duration::from_millis(
        variable(REST_VARIABLE)
            .and_then(|value| value.parse().ok())
            .unwrap_or(2_000),
    );
    let quit = variable(QUIT_VARIABLE).is_some_and(|value| value == "1");
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
                let (switched, cpu) = (Instant::now(), cpu_ms());
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
            let cpu = cpu_ms() - cpu_before;
            cx.background_executor().timer(rest.min(Duration::from_secs(1))).await;
            let (resident, footprint) = memory();
            this.update(cx, |shell, _| {
                if let Some(spike) = &mut shell.spike {
                    spike.write(&format!(
                        r#""event":"{}","to_frame_ms":{:.1},"frame_ms":{:.1},"cpu_ms":{cpu:.1},"resident_mb":{:.1},"footprint_mb":{:.1}"#,
                        screen.label(),
                        (framed - switched).as_secs_f64() * 1e3,
                        (framed - rendered).as_secs_f64() * 1e3,
                        resident as f64 / 1e6,
                        footprint as f64 / 1e6,
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

#[cfg(target_os = "macos")]
fn rusage() -> Option<libc::rusage_info_v2> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `usage` is a `rusage_info_v2`, the flavour asked for.
    let status = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V2,
            usage.as_mut_ptr().cast(),
        )
    };
    // SAFETY: zeroed is a valid `rusage_info_v2`, and the call filled it on success.
    (status == 0).then(|| unsafe { usage.assume_init() })
}

/// The process's resident size and footprint, in bytes.
#[cfg(target_os = "macos")]
fn memory() -> (u64, u64) {
    rusage().map_or((0, 0), |usage| {
        (usage.ri_resident_size, usage.ri_phys_footprint)
    })
}

/// The process's CPU time, user and system, in milliseconds. `rusage_info_v2` counts it in Mach
/// ticks, and `libc` marks its Mach clock bindings deprecated in favour of the `mach2` crate,
/// which is not worth a dependency for one reading.
#[cfg(target_os = "macos")]
#[expect(deprecated, reason = "libc's Mach clock is enough for one reading")]
fn cpu_ms() -> f64 {
    let Some(usage) = rusage() else {
        return 0.;
    };
    let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: a plain out-parameter.
    unsafe { libc::mach_timebase_info(&mut timebase) };
    if timebase.denom == 0 {
        return 0.;
    }
    (usage.ri_user_time + usage.ri_system_time) as f64 * f64::from(timebase.numer)
        / f64::from(timebase.denom)
        / 1e6
}

#[cfg(not(target_os = "macos"))]
fn memory() -> (u64, u64) {
    (0, 0)
}

#[cfg(not(target_os = "macos"))]
fn cpu_ms() -> f64 {
    0.
}
