//! An mpv core with its render context and threads, and the few kept between players.
//!
//! Most of a new player's wait for its first picture is not the file: making the core and its
//! render context, and above all the first frame mpv's renderer draws, which compiles its
//! shaders (about 20 ms on an M5 Pro, every time a render context is new). So a player that
//! goes gives its engine back: the file is stopped, what the player changed is put back, and
//! once the core has said it is at rest the engine waits for the next player, which loads its
//! file into it with the shaders already built. [`prewarm`] starts one before any video opens.
//!
//! The first file of a process pays more again, prewarmed or not: VideoToolbox's first decode,
//! the first audio output, the first shaders, about 150 ms with sound off and 190 ms with it on.
//! [`prime`] starts an engine that pays those ahead, opening a tiny clip once (`mpv/prime.rs`)
//! before it waits for a player, and View calls it when it shows a folder with videos in sight.
//! The first video then opens as a later one does, in 35 to 60 ms.
//!
//! At most [`KEPT`] wait, each for [`IDLE_KEEP`] after its last file, then shut down. A given-back
//! engine first lets go of what its last file's frames needed (`Backend::trim`), but its GL
//! context, shaders and threads still come to about 35 MB of footprint, which View at rest
//! should not keep.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::client::{self, Core};
use super::render::{self, Shared};
use super::{DEFAULT_REFRESH, LEAD_VARIABLE, MpvRender, OPTIONS_VARIABLE};
use crate::video::VideoError;

/// How many idle engines wait for a player: the viewer's next video opens while the last one
/// is still going, so the one it gives back serves the video after.
const KEPT: usize = 1;
/// How long an idle engine waits for a player before it shuts down.
const IDLE_KEEP: Duration = Duration::from_secs(30);
/// How long a given-back core may take to come to rest before it is shut down instead.
const REST_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the render thread may take to trim an engine at rest.
const TRIM_TIMEOUT: Duration = Duration::from_millis(500);
/// How long priming may take, from the clip's load to its first frame drawn at both sizes and
/// its audio ready, before the engine serves players as it is.
const PRIME_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a player's file stays loaded, paused, after the player goes, when it had sound.
/// Its audio output stays open meanwhile, and a new one opened then, by the next video in the
/// viewer or the tile hovered next, starts in 2 to 4 ms; once the last one in the process has
/// closed, the next takes 30 to 45 ms, and the first picture waits for it.
const AUDIO_HANDOVER: Duration = Duration::from_millis(500);

/// Idle engines, newest last.
static IDLE: Mutex<Vec<Idle>> = Mutex::new(Vec::new());
/// Wakes the janitor when [`IDLE`] changes.
static IDLE_CHANGED: Condvar = Condvar::new();
static JANITOR: Once = Once::new();
/// Whether [`prewarm`] is starting one.
static WARMING: AtomicBool = AtomicBool::new(false);
/// Engines given back and not yet idle: [`prewarm`] counts on them as on idle ones, since the
/// pointer leaves one playing tile as it reaches the next.
static RETURNING: AtomicUsize = AtomicUsize::new(0);

struct Idle {
    engine: Engine,
    /// When it shuts down if no player has taken it.
    until: Instant,
}

/// A core, its render thread and render context, and its event thread, all alive together.
pub(super) struct Engine {
    pub(super) core: Arc<Core>,
    pub(super) shared: Arc<Shared>,
    render: MpvRender,
    threads: Option<(JoinHandle<()>, JoinHandle<()>)>,
    /// Whether it has played a file, so its renderer has built shaders.
    used: bool,
}

impl Engine {
    /// An engine for `render`: an idle one if any waits, else a new one. Either way it is ready
    /// for [`Self::load`], with nothing left of a last file.
    pub(super) fn take(render: MpvRender) -> Result<Self, VideoError> {
        let idle = {
            let mut idle = IDLE.lock().unwrap_or_else(|p| p.into_inner());
            // One that has played first, for its shaders.
            let at = idle
                .iter()
                .rposition(|waiting| waiting.engine.render == render && waiting.engine.used)
                .or_else(|| {
                    idle.iter()
                        .rposition(|waiting| waiting.engine.render == render)
                });
            at.map(|at| idle.remove(at).engine)
        };
        let mut engine = match idle {
            Some(engine) => {
                engine.shared.begin_file();
                engine.core.observed().forget_file();
                engine
            }
            // A new one has had no file, and keeps a failure to make its render context.
            None => Self::start(render)?,
        };
        engine.used = true;
        Ok(engine)
    }

    /// Makes a new core with the player's options, and starts its threads.
    fn start(render: MpvRender) -> Result<Self, VideoError> {
        let mut options = vec![
            // Frames go to this process's render context, never a window of mpv's.
            ("vo", "libmpv"),
            // Not the owner's mpv.conf, scripts or key bindings: this is an embedded player.
            ("config", "no"),
            ("load-scripts", "no"),
            ("ytdl", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            // No on-screen display is drawn into the picture; the capsule is GPUI's.
            ("osd-level", "0"),
            ("osd-bar", "no"),
            // At the end, hold the last frame paused, as AVPlayer does.
            ("keep-open", "yes"),
            ("idle", "yes"),
            ("pause", "yes"),
            // Cover art is not a picture here.
            ("audio-display", "no"),
            // No subtitles, as in Electron Oriel: none of a file's own tracks, and no scan of its
            // folder for a same-named subtitle file on every open.
            ("sub-auto", "no"),
            ("sid", "no"),
            ("audio-client-name", "Oriel"),
        ];
        // Interleaved stereo for CoreAudio. This macOS refuses (-50) the channel layout mpv sets
        // on its audio unit for planar samples, which FFmpeg's AAC decoder gives, and for mono,
        // and mpv then drops the soundtrack: every AAC video played silent. Interleaved float
        // stereo it takes, so mpv converts to that (losslessly, but for a downmix of surround).
        #[cfg(target_os = "macos")]
        options.extend([("audio-format", "float"), ("audio-channels", "stereo")]);
        options.extend(render.options());
        let extra = std::env::var(OPTIONS_VARIABLE).unwrap_or_default();
        options.extend(
            extra
                .split(',')
                .filter_map(|option| option.split_once('='))
                .map(|(name, value)| (name.trim(), value.trim())),
        );
        let core = Core::start(&options)?;
        let lead_override = std::env::var(LEAD_VARIABLE)
            .ok()
            .and_then(|ms| ms.parse::<f64>().ok())
            .map(|ms| Duration::from_secs_f64(ms.max(0.) / 1000.));
        let shared = Shared::new(DEFAULT_REFRESH, lead_override);
        let events = core.spawn_events();
        let thread = match render {
            #[cfg(target_os = "macos")]
            MpvRender::OpenGl => {
                render::spawn(core.clone(), shared.clone(), super::opengl::OpenGl::new())
            }
            #[cfg(not(target_os = "macos"))]
            MpvRender::OpenGl => {
                return Err(VideoError::Unavailable("through OpenGL off macOS"));
            }
            MpvRender::Software => {
                render::spawn(core.clone(), shared.clone(), super::software::Software)
            }
        };
        Ok(Self {
            core,
            shared,
            render,
            threads: Some((thread, events)),
            used: false,
        })
    }

    /// Plays `path`, with its sound or without: the render thread hands it to mpv once its
    /// render context exists.
    pub(super) fn load(&self, path: String, sound: bool) {
        self.shared.request_load(path, sound);
    }

    /// Gives the engine back for the next player, off the caller's thread: it waits once the
    /// core is at rest, or shuts down if the core does not come to rest, its renderer failed,
    /// or enough engines wait already. A file played with `sound` stays loaded, paused, for
    /// [`AUDIO_HANDOVER`] first.
    pub(super) fn give_back(self, sound: bool) {
        if self.shared.failure().is_some() {
            self.shut_down();
            return;
        }
        RETURNING.fetch_add(1, Ordering::AcqRel);
        std::thread::Builder::new()
            .name("mpv-recycle".into())
            .spawn(move || {
                if sound {
                    std::thread::sleep(AUDIO_HANDOVER);
                }
                self.recycle();
                RETURNING.fetch_sub(1, Ordering::AcqRel);
            })
            .expect("spawn mpv's recycle thread");
    }

    /// Opens `clip` once, on this thread, so that what the first file of a process pays is paid
    /// now: VideoToolbox's first decode, the first audio output, and the renderer's shaders at
    /// the picture's own size (the viewer's) and scaled down (a tile's). Then the engine is at
    /// rest again, as a given-back one is. False if it could not be.
    fn prime(&mut self, clip: &Path) -> bool {
        let Some(path) = clip.to_str() else {
            return false;
        };
        let started = Instant::now();
        let until = |done: &dyn Fn(&Self) -> bool| {
            while !done(self) {
                if started.elapsed() > PRIME_TIMEOUT || self.shared.failure().is_some() {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            true
        };
        let restarts = self.core.observed().restarts;
        // Paused, as a player opens: the first frame is decoded and drawn, and the audio
        // output opened, which is what costs; the device is never started, so nothing plays.
        self.load(path.to_owned(), true);
        let first = until(&|engine| engine.shared.drawn() > 0);
        let drawn = self.shared.drawn();
        self.shared.set_max_side(Some(32));
        let scaled = first && until(&|engine| engine.shared.drawn() > drawn);
        // mpv starts playback, paused, once the audio output is open as well.
        let ready = until(&|engine| engine.core.observed().restarts > restarts);
        if let Some(why) = self.shared.failure() {
            log::warn!("libmpv's engine could not draw while priming: {why}");
            return false;
        }
        if !(scaled && ready) {
            log::info!(
                "libmpv's engine primed only in part in {:?}",
                started.elapsed()
            );
        }
        self.used = true;
        self.come_to_rest()
    }

    fn recycle(self) {
        if self.come_to_rest() {
            self.wait_for_player();
        } else {
            self.shut_down();
        }
    }

    /// Ends the file and waits for the core to be as a new one, then trims the renderer. False
    /// if the core did not come to rest or the renderer did not trim.
    fn come_to_rest(&self) -> bool {
        // Frames of the last file go now, and with them their IOSurfaces, and so does a load
        // the render thread had not yet handed mpv.
        self.shared.begin_file();
        self.core.unload();
        let started = Instant::now();
        while !self.core.observed().is_at_rest() {
            if started.elapsed() > REST_TIMEOUT {
                log::warn!("an mpv core did not come to rest; shutting it down");
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if !self.shared.trim(TRIM_TIMEOUT) {
            log::warn!("an mpv engine did not trim; shutting it down");
            return false;
        }
        self.core.observed().forget_file();
        true
    }

    /// Puts the engine among the idle ones until a player takes it or [`IDLE_KEEP`] passes.
    /// Past [`KEPT`], one goes: a new one first, as one that has played keeps its shaders,
    /// then the oldest.
    fn wait_for_player(self) {
        let surplus = {
            let mut idle = IDLE.lock().unwrap_or_else(|p| p.into_inner());
            idle.push(Idle {
                engine: self,
                until: Instant::now() + IDLE_KEEP,
            });
            let mut surplus = Vec::new();
            while idle.len() > KEPT {
                let at = idle
                    .iter()
                    .position(|waiting| !waiting.engine.used)
                    .unwrap_or(0);
                surplus.push(idle.remove(at).engine);
            }
            surplus
        };
        IDLE_CHANGED.notify_all();
        JANITOR.call_once(|| {
            std::thread::Builder::new()
                .name("mpv-idle".into())
                .spawn(janitor)
                .expect("spawn mpv's idle janitor");
        });
        surplus.into_iter().for_each(Engine::shut_down);
    }

    /// Ends the engine, off the caller's thread: the render thread frees its context, then the
    /// core quits.
    pub(super) fn shut_down(mut self) {
        self.shared.stop();
        if let Some((render, events)) = self.threads.take() {
            client::shut_down(self.core.clone(), render, events);
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // An engine dropped without `give_back` or `shut_down` still ends cleanly.
        self.shared.stop();
        if let Some((render, events)) = self.threads.take() {
            client::shut_down(self.core.clone(), render, events);
        }
    }
}

/// Shuts down each idle engine whose wait is over, for as long as the process runs.
fn janitor() {
    let mut idle = IDLE.lock().unwrap_or_else(|p| p.into_inner());
    loop {
        let now = Instant::now();
        let (expired, waiting): (Vec<Idle>, Vec<Idle>) =
            idle.drain(..).partition(|waiting| waiting.until <= now);
        *idle = waiting;
        if !expired.is_empty() {
            drop(idle);
            for waiting in expired {
                waiting.engine.shut_down();
            }
            idle = IDLE.lock().unwrap_or_else(|p| p.into_inner());
            continue;
        }
        idle = match idle.iter().map(|waiting| waiting.until).min() {
            Some(until) => {
                IDLE_CHANGED
                    .wait_timeout(idle, until.saturating_duration_since(now))
                    .unwrap_or_else(|p| p.into_inner())
                    .0
            }
            None => IDLE_CHANGED.wait(idle).unwrap_or_else(|p| p.into_inner()),
        };
    }
}

/// Starts an engine in the background for the first video to come, unless one waits, is on
/// its way back from a player, or is starting: the first open then skips loading libmpv and
/// making the core and its render context. It waits as any idle engine does, and shuts down if
/// no video comes within [`IDLE_KEEP`]. For a video about to open, as when the pointer rests on
/// a video tile: the engine is ready within tens of milliseconds.
pub fn prewarm() {
    start_ahead(false);
}

/// Starts an engine in the background as [`prewarm`] does, and primes it: it opens a tiny clip
/// once, so that VideoToolbox, the audio output and the renderer's shaders have paid their
/// first costs before the first video opens (150 to 190 ms of a first open, even prewarmed).
/// Priming takes about a quarter of a second, so this is for a video that may open soon, as
/// when View shows a folder that holds videos. Nothing is primed if an engine waits, returns or
/// starts already, or without the pinned ffmpeg to make the clip with (`mpv/prime.rs`).
pub fn prime() {
    start_ahead(true);
}

fn start_ahead(primed: bool) {
    // AVPlayer plays when `ORIEL_VIDEO` says so, and libmpv's engine would wait for nothing.
    if super::VideoEngine::from_env() != super::VideoEngine::Mpv {
        return;
    }
    let render = MpvRender::from_env();
    let waiting = IDLE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .any(|waiting| waiting.engine.render == render);
    if waiting || RETURNING.load(Ordering::Acquire) > 0 || WARMING.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::Builder::new()
        .name("mpv-prewarm".into())
        .spawn(move || {
            // Loading libmpv the first time is part of what this saves the caller.
            if !super::libmpv_available() {
                WARMING.store(false, Ordering::Release);
                return;
            }
            let clip = primed.then(super::prime::clip).flatten();
            let started = Engine::start(render);
            let ready = match started {
                Ok(mut engine) => match clip {
                    Some(clip) if !engine.prime(&clip) => {
                        engine.shut_down();
                        None
                    }
                    _ => Some(engine),
                },
                Err(error) => {
                    log::warn!("could not prewarm libmpv: {error}");
                    None
                }
            };
            // Waiting before it stops warming, so no caller in between starts another.
            if let Some(engine) = ready {
                engine.wait_for_player();
            }
            WARMING.store(false, Ordering::Release);
        })
        .expect("spawn mpv's prewarm thread");
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    /// A 3 s clip with sound from the pinned ffmpeg, in a folder of the test's own, or `None`
    /// without ffmpeg.
    fn clip(test: &str, name: &str) -> Option<PathBuf> {
        let tools = oriel_tools::MediaTools::locate().ok()?;
        let folder =
            std::env::temp_dir().join(format!("oriel-media-engine-{}-{test}", std::process::id()));
        std::fs::create_dir_all(&folder).ok()?;
        let path = folder.join(name);
        let made = std::process::Command::new(tools.ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=320x180:rate=25")
            .args(["-f", "lavfi", "-i", "sine=frequency=440", "-t", "3"])
            .args([
                "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-y",
            ])
            .arg(&path)
            .output()
            .ok()?;
        made.status.success().then_some(path)
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(started.elapsed() < Duration::from_secs(10), "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn play(engine: &Engine, path: &Path) {
        engine.load(path.to_str().unwrap().to_owned(), true);
        wait_until("the clip loads", || {
            let observed = engine.core.observed();
            observed.file_loaded && observed.picture_size().is_some()
        });
    }

    /// A player's engine comes back to the next player as a new one would: its file gone, its
    /// settings at mpv's defaults, and nothing the last file's events said, so the next file
    /// starts from what it says itself. The engine is the same one, with its shaders built.
    #[test]
    fn a_given_back_engine_comes_back_as_new() {
        let test = "given-back";
        let (Some(first), Some(second)) = (clip(test, "first.mp4"), clip(test, "second.mp4"))
        else {
            eprintln!(
                "skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)"
            );
            return;
        };
        if !super::super::libmpv_available() {
            eprintln!("skipped: no libmpv (cargo run -p xtask -- libmpv)");
            return;
        }
        let engine = Engine::take(MpvRender::OpenGl).expect("an engine starts");
        play(&engine, &first);
        engine.core.set_flag(c"mute", true);
        engine.core.set_double(c"volume", 40.);
        engine.core.set_double(c"speed", 1.5);
        engine.core.set_flag(c"pause", false);
        engine.shared.set_max_side(Some(64));
        wait_until("the settings apply", || {
            let observed = engine.core.observed();
            observed.muted && observed.speed == 1.5 && !observed.paused
        });
        let core = engine.core.clone();
        engine.give_back(true);
        wait_until("the engine waits for a player", || {
            IDLE.lock()
                .unwrap()
                .iter()
                .any(|waiting| Arc::ptr_eq(&waiting.engine.core, &core))
        });

        let engine = Engine::take(MpvRender::OpenGl).expect("the idle engine");
        assert!(
            Arc::ptr_eq(&engine.core, &core),
            "the same engine plays the next file"
        );
        {
            let observed = engine.core.observed();
            assert!(observed.is_at_rest());
            assert!(!observed.file_loaded && observed.failed.is_none());
        }
        assert_eq!(engine.shared.drawn(), 0);
        play(&engine, &second);
        assert_eq!(engine.core.observed().picture_size(), Some((320, 180)));
        engine.shut_down();
        std::fs::remove_dir_all(first.parent().unwrap()).ok();
    }

    /// A primed engine waits for its first player as a given-back one does: at rest, with
    /// nothing of the clip left in what the player reads, and with its shaders built.
    #[test]
    fn a_primed_engine_comes_as_new() {
        let test = "primed";
        let (Some(prime), Some(next)) = (clip(test, "prime.mp4"), clip(test, "next.mp4")) else {
            eprintln!(
                "skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)"
            );
            return;
        };
        if !super::super::libmpv_available() {
            eprintln!("skipped: no libmpv (cargo run -p xtask -- libmpv)");
            return;
        }
        let mut engine = Engine::start(MpvRender::OpenGl).expect("an engine starts");
        assert!(engine.prime(&prime), "the engine primes");
        assert!(engine.used, "its renderer has drawn");
        {
            let observed = engine.core.observed();
            assert!(observed.is_at_rest());
            assert!(!observed.file_loaded && observed.failed.is_none());
        }
        assert_eq!(engine.shared.drawn(), 0);
        play(&engine, &next);
        assert_eq!(engine.core.observed().picture_size(), Some((320, 180)));
        engine.shut_down();
        std::fs::remove_dir_all(prime.parent().unwrap()).ok();
    }

    /// A file loaded with its sound has its soundtrack playing through the audio output, even
    /// after the engine played a preview without sound: the clip's mono AAC is what CoreAudio
    /// refused until the engine asked mpv for interleaved stereo, and the AAC video played
    /// silent. Loaded paused, so nothing is heard.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_with_sound_reaches_the_audio_output() {
        let test = "sound";
        let (Some(preview), Some(viewer)) = (clip(test, "preview.mp4"), clip(test, "viewer.mp4"))
        else {
            eprintln!(
                "skipped: no pinned ffmpeg (cargo run -p oriel-tools --bin fetch-media-tools)"
            );
            return;
        };
        if !super::super::libmpv_available() {
            eprintln!("skipped: no libmpv (cargo run -p xtask -- libmpv)");
            return;
        }
        let audio = |engine: &Engine| {
            (
                engine.core.get_string(c"current-tracks/audio/codec"),
                engine.core.get_string(c"current-ao"),
            )
        };
        let engine = Engine::start(MpvRender::OpenGl).expect("an engine starts");
        engine.load(preview.to_str().unwrap().to_owned(), false);
        wait_until("the preview loads", || {
            engine.core.observed().picture_size().is_some()
        });
        assert_eq!(audio(&engine), (None, None), "a preview has no sound");
        assert!(engine.come_to_rest(), "the engine comes to rest");

        play(&engine, &viewer);
        wait_until("the soundtrack reaches the audio output", || {
            audio(&engine).1.is_some()
        });
        assert_eq!(
            audio(&engine),
            (Some("aac".to_owned()), Some("coreaudio".to_owned()))
        );
        assert_eq!(engine.core.get_string(c"mute").as_deref(), Some("no"));
        engine.shut_down();
        std::fs::remove_dir_all(viewer.parent().unwrap()).ok();
    }
}
