//! One mpv core: its options, the commands the player sends, and a thread that reads mpv's
//! events into [`Observed`], so the UI thread never waits on mpv. A core plays one file at a
//! time, and may play many in turn (`video/engine.rs` keeps idle ones for the next player).
//!
//! mpv's handle is thread-safe. The player's commands and property writes go out with mpv's
//! asynchronous calls, which return at once; the UI reads only [`Observed`], which the event
//! thread keeps current from the properties it observes. Only the event thread waits on mpv's
//! core: to read where a seek landed, and to choose a file's decoder while mpv holds the file
//! open for it.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::VideoError;
use super::ffi::{self, Libmpv};

/// The properties the event thread observes, by the reply id mpv echoes back.
const OBSERVED: [(u64, &CStr, c_int); 12] = [
    (1, c"duration", ffi::FORMAT_DOUBLE),
    (2, c"time-pos", ffi::FORMAT_DOUBLE),
    (3, c"pause", ffi::FORMAT_FLAG),
    (4, c"eof-reached", ffi::FORMAT_FLAG),
    (5, c"volume", ffi::FORMAT_DOUBLE),
    (6, c"mute", ffi::FORMAT_FLAG),
    (7, c"dwidth", ffi::FORMAT_INT64),
    (8, c"dheight", ffi::FORMAT_INT64),
    (9, c"avsync", ffi::FORMAT_DOUBLE),
    (11, c"speed", ffi::FORMAT_DOUBLE),
    (12, c"idle-active", ffi::FORMAT_FLAG),
    (13, c"hwdec-current", ffi::FORMAT_STRING),
];

/// The reply id of the `loadfile` command, so its failure is told from others'.
const LOADFILE_REPLY: u64 = 1;
/// The reply id of a core's first seek, which is that seek's number; each later seek's is one
/// more ([`Core::seek`]).
const FIRST_SEEK: u64 = 2;
/// How many of mpv's error lines are kept to explain a failure.
const KEPT_ERRORS: usize = 4;
/// `MPV_ERROR_OPTION_NOT_FOUND`.
const ERROR_OPTION_NOT_FOUND: c_int = -5;
/// Options that only switch off what a build may lack altogether: scripts (`load-scripts`, in
/// builds with Lua, JavaScript or C plugins) and youtube-dl (`ytdl`, with Lua). Oriel's LGPL
/// build has none of those, so mpv does not know these options, which is the same as off.
const OFF_WHEN_ABSENT: [&str; 2] = ["load-scripts", "ytdl"];

/// The most pixels a second of a picture that is light to decode in software: 1080p at 60
/// frames a second, and a little over for a rate that is not quite even.
const SOFTWARE_PIXEL_RATE: f64 = 1920. * 1080. * 62.;
/// The most pixels of an AV1 frame whose seek a second core in software shows sooner: 1080p,
/// with the rows a coded frame may have over it.
const SEEK_PICTURE_AV1_PIXELS: f64 = 1920. * 1088.;
/// The frames a second a video track is taken to have when its file does not say.
const UNSTATED_RATE: f64 = 60.;

/// How a file's video is decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decode {
    /// In hardware, whatever the picture: the least CPU, for a preview, which never seeks.
    Hardware,
    /// As makes its exact seeks quick, where anything does ([`quick_seeks`]): for a player
    /// with a scrubber.
    ForSeeking,
    /// In software, whatever the picture: for the core that shows a seek's picture
    /// ([`QuickSeeks::BySeekPicture`]).
    Software,
}

/// How a file's exact seeks are made quick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum QuickSeeks {
    /// They are not: the file is decoded in hardware, and its seeks take what that takes.
    #[default]
    No,
    /// The file is decoded in software, which also plays it.
    InSoftware,
    /// The file plays in hardware, and a second core decodes it in software to show an exact
    /// seek's picture first (`video/seek_picture.rs`). Where the hardware does not take the
    /// file ([`Observed::hardware`]) mpv decodes it in software in the one core, with no second.
    BySeekPicture,
}

/// How a video of `codec`, with `pixels` a frame and `rate` frames a second, has its exact
/// seeks made quick in a player that seeks.
///
/// An exact seek decodes every frame from the keyframe before its target, and in H.264 and AV1
/// FFmpeg's own decoder and dav1d, on every core, get there sooner than the hardware path does.
/// HEVC seeks later in software everywhere measured, so it stays in hardware alone.
///
/// On macOS FFmpeg hands the hardware decoder one frame at a time and waits for it, which at
/// 1440p comes to 390 to 770 frames a second by codec. The hardware is not what is slow:
/// VideoToolbox handed the same frames without a wait decodes 1,100 to 1,600 of them a second,
/// but neither FFmpeg nor mpv can drive it so. Playing is what hardware does for less there:
/// in software 720p30 H.264 takes 21 % of a core, where hardware takes 11 %, and 1080p60 AV1
/// takes 70 %, where hardware takes 20 %. So the file plays in hardware and a second core shows
/// each seek's picture. On an M5 Pro, over the videos of a library in use, the picture of an
/// exact seek then comes in a median of 18 ms, where the player's own core lands in 50 ms, in
/// H.264 (720p, a keyframe every 3 s), and in 80 ms, not 152 ms, in AV1 (Shrink's, a keyframe
/// every 5 s). H.264 gains at every size: over made clips with a keyframe every 5 s, 72 ms,
/// not 245 ms, at 1440p60 and 128 ms, not 424 ms, at 4K60. AV1 above 1080p gained in one clip
/// and lost in another, so it gets no second core.
///
/// On Windows the software renderer has each hardware frame copied back to memory
/// (`d3d11va-copy`), which halves the hardware's rate, and in H.264 the hardware is the slower
/// decoder even before the copy. Playing costs the same CPU either way there, as near as it
/// was measured, since the copy costs about what decoding does: so software decodes the file,
/// with no second core, where the picture is light enough to play so. On a Ryzen 5 5600H with
/// an RTX 3060, over clips with a keyframe every 5 s, the median exact seek fell from 69 ms to
/// 33 ms in 720p30 H.264, from 203 ms to 87 ms in 1080p60 H.264 and from 266 ms to 194 ms in
/// 1080p60 AV1; 720p AV1 seeks the same either way.
///
/// Linux is not measured, so there every picture stays in hardware.
fn quick_seeks(codec: &str, pixels: f64, rate: f64) -> QuickSeeks {
    if cfg!(target_os = "macos") {
        match codec {
            "h264" => QuickSeeks::BySeekPicture,
            "av1" if pixels <= SEEK_PICTURE_AV1_PIXELS => QuickSeeks::BySeekPicture,
            _ => QuickSeeks::No,
        }
    } else if cfg!(target_os = "windows")
        && matches!(codec, "h264" | "av1")
        && pixels * rate <= SOFTWARE_PIXEL_RATE
    {
        QuickSeeks::InSoftware
    } else {
        QuickSeeks::No
    }
}

/// What the player reads of mpv's state, as of the newest event.
#[derive(Default)]
pub(super) struct Observed {
    pub(super) file_loaded: bool,
    pub(super) failed: Option<VideoError>,
    pub(super) duration: Option<f64>,
    pub(super) time_pos: Option<f64>,
    pub(super) paused: bool,
    pub(super) eof_reached: bool,
    /// mpv's volume, 0 to 100.
    pub(super) volume: f64,
    pub(super) muted: bool,
    pub(super) speed: f64,
    /// The picture's size as shown (aspect applied); `None` until the video is configured.
    pub(super) display_size: (Option<i64>, Option<i64>),
    /// mpv's own audio clock less the shown frame's time, in seconds.
    pub(super) avsync: Option<f64>,
    /// Seeks mpv has finished with their first frame drawn (`MPV_EVENT_PLAYBACK_RESTART`).
    pub(super) restarts: u64,
    /// `time-pos` when the newest restart came: where the newest seek landed.
    pub(super) restart_pos: Option<f64>,
    pub(super) restarted_at: Option<Instant>,
    /// Whether the core has no file (`idle-active`): stopped, or never given one.
    pub(super) idle: bool,
    /// The number of the newest seek that has landed, its first frame drawn: the seek mpv was
    /// making when the newest restart came ([`Core::seek`]).
    pub(super) landed: u64,
    /// The number of the seek mpv started last, and when. Every frame it draws from then on
    /// is of that seek or a later one, restart or no: in a run of seeks mpv draws each one's
    /// frame and starts the next without a restart.
    pub(super) started: Option<(u64, Instant)>,
    /// How the file's exact seeks are made quick, as chosen when it opened.
    pub(super) quick_seeks: QuickSeeks,
    /// Whether hardware decodes the video (`hwdec-current`), once mpv has a decoder for it:
    /// mpv falls back to software where the hardware does not take a file.
    pub(super) hardware: Option<bool>,
    errors: Vec<String>,
}

impl Observed {
    /// Forgets what the events said about the last file, before the core plays the next. What
    /// the observed properties say stays: mpv sends a property only when it changes, so the
    /// event thread's copy is already the core's.
    pub(super) fn forget_file(&mut self) {
        self.file_loaded = false;
        self.quick_seeks = QuickSeeks::No;
        self.failed = None;
        self.errors.clear();
    }

    /// Whether the core is as a new one starts: no file, so no picture, length or position,
    /// and the player's settings back at mpv's defaults. Once the event thread has heard all
    /// this, nothing more of the last file is on its way.
    pub(super) fn is_at_rest(&self) -> bool {
        self.idle
            && self.paused
            && !self.muted
            && !self.eof_reached
            && self.volume == 100.
            && self.speed == 1.
            && self.display_size == (None, None)
            && self.duration.is_none()
            && self.time_pos.is_none()
    }

    pub(super) fn picture_size(&self) -> Option<(u32, u32)> {
        match self.display_size {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
            }
            _ => None,
        }
    }
}

/// An mpv core with its event thread. Dropping it ends both, off the caller's thread.
pub(super) struct Core {
    api: &'static Libmpv,
    handle: NonNull<ffi::Handle>,
    observed: Mutex<Observed>,
    /// Signalled by the event thread after each event it reads into [`Observed`].
    changed: Condvar,
    /// Called on the event thread when the picture's size changes.
    size_listener: Mutex<Option<Box<dyn Fn() + Send>>>,
    /// The `hwdec` the core was started with: how it decodes in hardware.
    hardware: CString,
    /// How the file loaded last is to be decoded.
    decode: Mutex<Decode>,
    /// The number the next seek takes.
    seeks: AtomicU64,
}

// SAFETY: mpv's client API is thread-safe for one handle ("all functions are thread-safe unless
// stated otherwise"); the only state here besides the handle is behind a mutex or atomic.
unsafe impl Send for Core {}
// SAFETY: as above.
unsafe impl Sync for Core {}

impl Core {
    /// Creates and starts a core with `options`, which must include `vo=libmpv`: the file is
    /// loaded later, once a render context exists.
    pub(super) fn start(options: &[(&str, &str)]) -> Result<Arc<Core>, VideoError> {
        let api = Libmpv::get().map_err(|why| VideoError::Failed {
            code: 0,
            message: format!("libmpv is not available: {why}"),
        })?;
        // SAFETY: a plain constructor; NULL means out of memory.
        let handle = NonNull::new(unsafe { (api.create)() }).ok_or(VideoError::Failed {
            code: 0,
            message: "libmpv could not create a player".into(),
        })?;
        let core = Core {
            api,
            handle,
            observed: Mutex::new(Observed {
                volume: 100.,
                speed: 1.,
                ..Observed::default()
            }),
            changed: Condvar::new(),
            size_listener: Mutex::new(None),
            hardware: c_string(
                options
                    .iter()
                    .rev()
                    .find(|(name, _)| *name == "hwdec")
                    .map_or("no", |(_, value)| value),
            ),
            decode: Mutex::new(Decode::Hardware),
            seeks: AtomicU64::new(FIRST_SEEK),
        };
        for (name, value) in options {
            let (name_c, value_c) = (c_string(name), c_string(value));
            // SAFETY: a live handle and NUL-terminated strings, before mpv_initialize.
            let status = unsafe {
                (api.set_option_string)(handle.as_ptr(), name_c.as_ptr(), value_c.as_ptr())
            };
            let absent = status == ERROR_OPTION_NOT_FOUND && OFF_WHEN_ABSENT.contains(name);
            if status < 0 && !(absent && *value == "no") {
                return Err(core.failure(status, &format!("option {name}={value}")));
            }
        }
        // SAFETY: a live, configured handle.
        let status = unsafe { (api.initialize)(handle.as_ptr()) };
        if status < 0 {
            return Err(core.failure(status, "start"));
        }
        // SAFETY: a live handle and a NUL-terminated level.
        unsafe { (api.request_log_messages)(handle.as_ptr(), c"error".as_ptr()) };
        for (id, name, format) in OBSERVED {
            // SAFETY: a live handle, a NUL-terminated name and one of mpv's formats.
            unsafe { (api.observe_property)(handle.as_ptr(), id, name.as_ptr(), format) };
        }
        // mpv waits here on each file it opens, with its tracks known and no decoder made
        // yet, for the event thread to choose how the video is decoded.
        // SAFETY: a live handle and a NUL-terminated name.
        let status = unsafe { (api.hook_add)(handle.as_ptr(), 0, c"on_preloaded".as_ptr(), 0) };
        if status < 0 {
            log::warn!(
                "mpv refused the hook that chooses a decoder: {}",
                api.describe(status)
            );
        }
        Ok(Arc::new(core))
    }

    pub(super) fn api(&self) -> &'static Libmpv {
        self.api
    }

    pub(super) fn handle(&self) -> *mut ffi::Handle {
        self.handle.as_ptr()
    }

    pub(super) fn observed(&self) -> MutexGuard<'_, Observed> {
        self.observed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Waits until `done` holds of what the events said, or `deadline` passes. False if it
    /// passed first.
    pub(super) fn wait_until(&self, deadline: Instant, done: impl Fn(&Observed) -> bool) -> bool {
        let mut observed = self.observed();
        while !done(&observed) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            observed = self
                .changed
                .wait_timeout(observed, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        true
    }

    /// Has the event thread call `listener` whenever the picture's size changes.
    pub(super) fn on_size_change(&self, listener: Box<dyn Fn() + Send>) {
        *self
            .size_listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(listener);
    }

    /// mpv's clock, in nanoseconds; the one `mpv_render_frame_info::target_time` is on (in µs).
    /// Safe from a render thread.
    pub(super) fn now_ns(&self) -> i64 {
        // SAFETY: a live handle; documented as callable from anywhere.
        unsafe { (self.api.get_time_ns)(self.handle()) }
    }

    /// Runs mpv's input command `args` without waiting for it. Safe from a render thread.
    pub(super) fn command(&self, reply: u64, args: &[&str]) {
        let owned: Vec<CString> = args.iter().map(|arg| c_string(arg)).collect();
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        // SAFETY: a live handle and a NULL-terminated array of NUL-terminated strings, which
        // mpv copies before returning.
        let status =
            unsafe { (self.api.command_async)(self.handle(), reply, pointers.as_mut_ptr()) };
        if status < 0 {
            log::warn!("mpv refused {args:?}: {}", self.api.describe(status));
        }
    }

    /// Loads the file, its video decoded as `decode` says. Called once a render context exists,
    /// so the video output can start. Without `sound` the soundtrack is never selected, for
    /// this file only: nothing decodes it and no audio device opens.
    pub(super) fn load(&self, path: &str, sound: bool, decode: Decode) {
        *self.decode.lock().unwrap_or_else(|p| p.into_inner()) = decode;
        if sound {
            self.command(LOADFILE_REPLY, &["loadfile", path]);
        } else {
            self.command(
                LOADFILE_REPLY,
                &["loadfile", path, "replace", "-1", "aid=no"],
            );
        }
    }

    /// Seeks to `seconds` into the file, on the frame there if `exact` and else on a keyframe
    /// near it, without waiting. Returns the seek's number: [`Observed::landed`] reaches it
    /// once this seek, or a later one that replaced it, has its first frame drawn.
    pub(super) fn seek(&self, seconds: f64, exact: bool) -> u64 {
        let number = self.seeks.fetch_add(1, Ordering::Relaxed);
        let flags = if exact {
            "absolute+exact"
        } else {
            "absolute+keyframes"
        };
        self.command(number, &["seek", &format!("{seconds:.6}"), flags]);
        number
    }

    /// Unloads the file and puts back what a player may have changed, so the core is as a new
    /// one for the next: paused, unmuted, at full volume and normal speed, not looping.
    pub(super) fn unload(&self) {
        self.set_flag(c"pause", true);
        self.command(0, &["stop"]);
        self.set_flag(c"mute", false);
        self.set_double(c"volume", 100.);
        self.set_double(c"speed", 1.);
        self.command(0, &["set", "loop-file", "no"]);
    }

    pub(super) fn set_flag(&self, name: &CStr, value: bool) {
        let mut value = c_int::from(value);
        // SAFETY: a live handle, a NUL-terminated name and an int for MPV_FORMAT_FLAG; mpv
        // copies the value before returning.
        unsafe {
            (self.api.set_property_async)(
                self.handle(),
                0,
                name.as_ptr(),
                ffi::FORMAT_FLAG,
                (&raw mut value).cast(),
            )
        };
    }

    pub(super) fn set_double(&self, name: &CStr, value: f64) {
        let mut value = value;
        // SAFETY: as `set_flag`, with a double for MPV_FORMAT_DOUBLE.
        unsafe {
            (self.api.set_property_async)(
                self.handle(),
                0,
                name.as_ptr(),
                ffi::FORMAT_DOUBLE,
                (&raw mut value).cast(),
            )
        };
    }

    /// A property read that waits for mpv's core: for the event thread and measurements only,
    /// never the UI's hot path.
    pub(super) fn get_double(&self, name: &CStr) -> Option<f64> {
        let mut value = 0f64;
        // SAFETY: a live handle, a NUL-terminated name and a double for MPV_FORMAT_DOUBLE.
        let status = unsafe {
            (self.api.get_property)(
                self.handle(),
                name.as_ptr(),
                ffi::FORMAT_DOUBLE,
                (&raw mut value).cast(),
            )
        };
        (status >= 0).then_some(value)
    }

    /// A property as mpv's string, waiting for the core, as `get_double`.
    pub(super) fn get_string(&self, name: &CStr) -> Option<String> {
        // SAFETY: a live handle and a NUL-terminated name; the result is mpv's to free.
        unsafe {
            let raw = (self.api.get_property_string)(self.handle(), name.as_ptr());
            if raw.is_null() {
                return None;
            }
            let value = CStr::from_ptr(raw).to_string_lossy().into_owned();
            (self.api.free)(raw.cast());
            Some(value)
        }
    }

    /// Starts the thread that reads mpv's events until the core shuts down.
    pub(super) fn spawn_events(self: &Arc<Self>) -> JoinHandle<()> {
        let core = self.clone();
        std::thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || core.read_events())
            .expect("spawn mpv's event thread")
    }

    fn read_events(&self) {
        // mpv answers a seek when it has queued it, sends `MPV_EVENT_SEEK` when it starts the
        // one queued last, and a restart when the one started last has its first frame drawn.
        // A seek queued while another is under way replaces any queued before it, and after a
        // third of a second the one under way too. So the newest seek answered when a seek
        // starts is the one that restart is of.
        let (mut queued, mut under_way) = (0, 0);
        loop {
            // SAFETY: a live handle; only this thread waits on it. The event stays valid until
            // the next call.
            let event = unsafe { &*(self.api.wait_event)(self.handle(), -1.) };
            match event.event_id {
                ffi::EVENT_NONE => {}
                ffi::EVENT_SHUTDOWN => return,
                ffi::EVENT_PROPERTY_CHANGE => {
                    // SAFETY: mpv gives a property change an `mpv_event_property`.
                    let property = unsafe { &*event.data.cast::<ffi::EventProperty>() };
                    self.property_changed(event.reply_userdata, property);
                }
                ffi::EVENT_FILE_LOADED => self.observed().file_loaded = true,
                ffi::EVENT_HOOK => {
                    // SAFETY: mpv gives a hook an `mpv_event_hook`.
                    let id = unsafe { &*event.data.cast::<ffi::EventHook>() }.id;
                    self.choose_decoder();
                    // SAFETY: a live handle and the hook mpv waits on, which it goes on from.
                    unsafe { (self.api.hook_continue)(self.handle(), id) };
                }
                ffi::EVENT_COMMAND_REPLY if event.reply_userdata >= FIRST_SEEK => {
                    if event.error < 0 {
                        // A seek mpv refused has nothing to land.
                        let mut observed = self.observed();
                        observed.landed = observed.landed.max(event.reply_userdata);
                    } else {
                        queued = event.reply_userdata;
                    }
                }
                ffi::EVENT_SEEK => {
                    under_way = queued;
                    self.observed().started = Some((under_way, Instant::now()));
                }
                ffi::EVENT_PLAYBACK_RESTART => {
                    // Timed before the read, which waits on mpv's core. The position is read
                    // now, while the first frame after the seek is the one shown.
                    let at = Instant::now();
                    let position = self.get_double(c"time-pos");
                    let mut observed = self.observed();
                    observed.restarts += 1;
                    observed.landed = observed.landed.max(under_way);
                    observed.restart_pos = position;
                    observed.restarted_at = Some(at);
                }
                ffi::EVENT_END_FILE => {
                    // SAFETY: mpv gives an end of file an `mpv_event_end_file`.
                    let end = unsafe { &*event.data.cast::<ffi::EventEndFile>() };
                    if end.reason == ffi::END_FILE_REASON_ERROR {
                        let failure = self.failure(end.error, "play this file");
                        self.observed().failed = Some(failure);
                    }
                }
                ffi::EVENT_COMMAND_REPLY
                    if event.reply_userdata == LOADFILE_REPLY && event.error < 0 =>
                {
                    let failure = self.failure(event.error, "open this file");
                    self.observed().failed = Some(failure);
                }
                ffi::EVENT_LOG_MESSAGE => {
                    // SAFETY: mpv gives a log message an `mpv_event_log_message` of C strings.
                    let message = unsafe { &*event.data.cast::<ffi::EventLogMessage>() };
                    // SAFETY: as above.
                    let text = unsafe { CStr::from_ptr(message.text) }.to_string_lossy();
                    let mut observed = self.observed();
                    if observed.errors.len() == KEPT_ERRORS {
                        observed.errors.remove(0);
                    }
                    observed.errors.push(text.trim().to_owned());
                }
                _ => {}
            }
            self.changed.notify_all();
        }
    }

    /// Sets how the file mpv has just opened is decoded, before mpv makes its decoders: in
    /// software where that is what was asked or what makes its seeks quick, else as the core
    /// was started. Every file sets it, as the core keeps the last file's.
    fn choose_decoder(&self) {
        let decode = *self.decode.lock().unwrap_or_else(|p| p.into_inner());
        let quick_seeks = match decode {
            Decode::Hardware => QuickSeeks::No,
            Decode::Software => QuickSeeks::InSoftware,
            Decode::ForSeeking => self
                .video_track()
                .map_or(QuickSeeks::No, |(codec, pixels, rate)| {
                    quick_seeks(&codec, pixels, rate)
                }),
        };
        let software = quick_seeks == QuickSeeks::InSoftware;
        let hwdec = if software { c"no" } else { &*self.hardware };
        // SAFETY: a live handle and NUL-terminated strings, which mpv copies before returning.
        let status = unsafe {
            (self.api.set_property_string)(self.handle(), c"hwdec".as_ptr(), hwdec.as_ptr())
        };
        if status < 0 {
            log::warn!("mpv refused hwdec={hwdec:?}: {}", self.api.describe(status));
        }
        self.observed().quick_seeks = if software && status < 0 {
            QuickSeeks::No
        } else {
            quick_seeks
        };
    }

    /// The codec, pixels a frame and frames a second of the video track mpv will play, which
    /// it has not yet selected: of those that are neither cover art nor a still image, the one
    /// the file marks as its default, else the first, as mpv chooses among such tracks.
    fn video_track(&self) -> Option<(String, f64, f64)> {
        let count = self.get_double(c"track-list/count")? as usize;
        let of = |index: usize, field: &str| c_string(&format!("track-list/{index}/{field}"));
        let says = |index: usize, field: &str| {
            self.get_string(&of(index, field)).as_deref() == Some("yes")
        };
        let mut pictures = (0..count).filter(|index| {
            self.get_string(&of(*index, "type")).as_deref() == Some("video")
                && !says(*index, "albumart")
                && !says(*index, "image")
        });
        let first = pictures.next()?;
        let index = std::iter::once(first)
            .chain(pictures)
            .find(|index| says(*index, "default"))
            .unwrap_or(first);
        let pixels =
            self.get_double(&of(index, "demux-w"))? * self.get_double(&of(index, "demux-h"))?;
        let rate = self
            .get_double(&of(index, "demux-fps"))
            .filter(|rate| *rate > 0.)
            .unwrap_or(UNSTATED_RATE);
        Some((self.get_string(&of(index, "codec"))?, pixels, rate))
    }

    fn property_changed(&self, id: u64, property: &ffi::EventProperty) {
        // SAFETY: mpv's data matches the format it states, and NONE means unavailable.
        let (double, flag, int, string) = unsafe {
            let data = property.data;
            match property.format {
                ffi::FORMAT_DOUBLE => (Some(*data.cast::<f64>()), None, None, None),
                ffi::FORMAT_FLAG => (None, Some(*data.cast::<c_int>() != 0), None, None),
                ffi::FORMAT_INT64 => (None, None, Some(*data.cast::<i64>()), None),
                ffi::FORMAT_STRING => {
                    let text = CStr::from_ptr(*data.cast::<*const c_char>());
                    (None, None, None, Some(text.to_string_lossy().into_owned()))
                }
                _ => (None, None, None, None),
            }
        };
        let mut observed = self.observed();
        match id {
            1 => observed.duration = double,
            2 => observed.time_pos = double,
            3 => observed.paused = flag.unwrap_or(false),
            4 => observed.eof_reached = flag.unwrap_or(false),
            5 => observed.volume = double.unwrap_or(100.),
            6 => observed.muted = flag.unwrap_or(false),
            7 => observed.display_size.0 = int,
            8 => observed.display_size.1 = int,
            9 => observed.avsync = double,
            11 => observed.speed = double.unwrap_or(1.),
            12 => observed.idle = flag.unwrap_or(false),
            13 => observed.hardware = string.map(|decoder| decoder != "no"),
            _ => {}
        }
        drop(observed);
        if matches!(id, 7 | 8)
            && let Some(listener) = self
                .size_listener
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
        {
            listener();
        }
    }

    /// A failure in mpv's words, with its newest error lines when it logged any.
    fn failure(&self, status: c_int, doing: &str) -> VideoError {
        let errors = self.observed().errors.join(" ");
        let reason = self.api.describe(status);
        VideoError::Failed {
            code: i64::from(status),
            message: if errors.is_empty() {
                format!("mpv could not {doing} ({reason})")
            } else {
                format!("{errors} ({reason})")
            },
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // SAFETY: the last reference: the event thread has returned (it holds one), and every
        // render context was freed by its thread first.
        unsafe { (self.api.terminate_destroy)(self.handle()) };
    }
}

/// Ends `core` on a thread of its own, since mpv may take a moment: waits for the render thread
/// (which the caller has told to stop), tells mpv to quit, waits for the event thread to see the
/// shutdown, then destroys the core.
pub(super) fn shut_down(core: Arc<Core>, render: JoinHandle<()>, events: JoinHandle<()>) {
    std::thread::Builder::new()
        .name("mpv-teardown".into())
        .spawn(move || {
            let started = Instant::now();
            // The render thread frees its context first: mpv requires that before the core goes.
            render.join().ok();
            // `quit` ends with MPV_EVENT_SHUTDOWN, on which the event thread returns; only then
            // may the handle be destroyed, as no thread may wait on it meanwhile.
            core.command(0, &["quit"]);
            events.join().ok();
            if started.elapsed() > Duration::from_secs(1) {
                log::warn!("mpv took {:?} to shut down", started.elapsed());
            }
            drop(core);
        })
        .expect("spawn mpv's teardown thread");
}

fn c_string(text: &str) -> CString {
    CString::new(text.replace('\0', "")).expect("NULs were removed")
}

/// A raw pointer that may cross threads, for mpv's callback context. Whoever makes one keeps
/// the pointee alive for as long as mpv may call back with it.
#[derive(Clone, Copy)]
pub(super) struct SendPtr(pub(super) *mut c_void);

// SAFETY: see the type's docs; the pointee is `Sync`.
unsafe impl Send for SendPtr {}
