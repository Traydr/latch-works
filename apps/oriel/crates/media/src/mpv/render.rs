//! The render thread both backends share: it waits for mpv's update callback, asks what the
//! next frame is and when mpv means it to be seen, waits until just early enough for the window
//! to show it then, has the backend draw it, and queues the picture for the UI thread to take.
//! It lives as long as its core, through every file the core plays: each file is a new
//! generation of [`Shared`], and a frame of an older one never reaches the window.
//!
//! mpv's render API wants this on a thread of its own: the thread calls only `mpv_render_*` and
//! the calls mpv marks safe there, and never waits on a thread that calls the rest. Here it
//! reads the picture's size from the event thread's [`Observed`](super::client::Observed), behind
//! a mutex no one holds across an mpv call.

use std::collections::VecDeque;
use std::ffi::{c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use gpui_kit::RenderImage;

use super::client::{Core, SendPtr};
use super::ffi;

/// The longest the thread sleeps toward a frame's time: past this the time is taken as wrong.
const MAX_WAIT: Duration = Duration::from_millis(250);
/// How late a sleep at the user-interactive class ends, at most, as measured on an M5 Pro.
const WAKE_SLACK_NS: i64 = 1_000_000;
/// How many drawn frames wait for the window at most; past that the oldest goes unseen.
const QUEUED: usize = 3;
/// How many frames' draw starts are kept to find a seek's first frame.
const BEGUN_KEPT: usize = 32;
/// The weight of each new draw time in the running average the lead is worked out from.
const DRAW_WEIGHT: f64 = 0.1;

/// A picture as a backend draws it.
pub(super) enum Picture {
    /// The software renderer's pixels, for `img()`: a new atlas texture per frame.
    Image(Arc<RenderImage>),
    /// The OpenGL renderer's picture converted to GPUI's `420f`, for `surface()`.
    #[cfg(target_os = "macos")]
    Buffer(PixelBuffer),
}

/// A `CVPixelBuffer` that may cross threads: CoreVideo's buffers are reference-counted and
/// their IOSurface-backed pixels are only read once handed on.
#[cfg(target_os = "macos")]
pub(super) struct PixelBuffer(
    pub(super) objc2_core_foundation::CFRetained<objc2_core_video::CVPixelBuffer>,
);

// SAFETY: see the type's docs; CoreVideo's retain and release are atomic.
#[cfg(target_os = "macos")]
unsafe impl Send for PixelBuffer {}

impl Picture {
    /// The picture as 8-bit RGB rows, as GPUI puts it on screen: BGRA as it is, and `420f`
    /// through the BT.601 full-range matrix of GPUI's surface shader, with chroma taken from
    /// the nearest sample. For measurements: it reads every pixel on the CPU.
    pub(super) fn rgb(&self) -> Option<(u32, u32, Vec<u8>)> {
        match self {
            Picture::Image(image) => {
                let size = image.size(0);
                let (width, height) = (size.width.0 as u32, size.height.0 as u32);
                let rgb = image
                    .as_bytes(0)?
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|[blue, green, red, _]| [*red, *green, *blue])
                    .collect();
                Some((width, height, rgb))
            }
            #[cfg(target_os = "macos")]
            Picture::Buffer(buffer) => surface_rgb(&buffer.0),
        }
    }
}

#[cfg(target_os = "macos")]
fn surface_rgb(buffer: &objc2_core_video::CVPixelBuffer) -> Option<(u32, u32, Vec<u8>)> {
    use objc2_core_video::{
        CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
        CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidthOfPlane, CVPixelBufferLockBaseAddress,
        CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    };
    let flags = CVPixelBufferLockFlags::ReadOnly;
    // SAFETY: a live buffer, locked for reading around every access to its planes, which hold
    // `bytes per row * height` bytes each.
    unsafe {
        if CVPixelBufferLockBaseAddress(buffer, flags) != 0 {
            return None;
        }
        let plane = |index| {
            let base = CVPixelBufferGetBaseAddressOfPlane(buffer, index).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, index);
            let height = CVPixelBufferGetHeightOfPlane(buffer, index);
            (base, stride, height)
        };
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0);
        let (luma, luma_stride, height) = plane(0);
        let (chroma, chroma_stride, chroma_height) = plane(1);
        if luma.is_null() || chroma.is_null() {
            CVPixelBufferUnlockBaseAddress(buffer, flags);
            return None;
        }
        let luma = std::slice::from_raw_parts(luma, luma_stride * height);
        let chroma = std::slice::from_raw_parts(chroma, chroma_stride * chroma_height);
        let mut rgb = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let luma = f32::from(luma[y * luma_stride + x]) / 255.;
                let at = (y / 2).min(chroma_height - 1) * chroma_stride + (x / 2) * 2;
                let cb = f32::from(chroma[at]) / 255. - 0.5;
                let cr = f32::from(chroma[at + 1]) / 255. - 0.5;
                // GPUI's `surface_fragment`, constant for constant.
                let channels = [
                    luma + 1.402 * cr,
                    luma - 0.3441 * cb - 0.7141 * cr,
                    luma + 1.772 * cb,
                ];
                rgb.extend(channels.map(|c| (c.clamp(0., 1.) * 255.).round() as u8));
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, flags);
        Some((width as u32, height as u32, rgb))
    }
}

/// One frame the render thread finished.
pub(super) struct Rendered {
    pub(super) picture: Picture,
    /// When mpv meant it to be seen; `None` for a redraw (paused, say).
    pub(super) due: Option<Instant>,
    /// The file it is of, as [`Shared::begin_file`] counts them.
    generation: u64,
    pub(super) rendered_at: Instant,
    /// Its place among the frames drawn, from 1.
    pub(super) number: u64,
    /// How long the backend took to draw it.
    pub(super) draw_time: Duration,
}

/// What a backend does on the render thread.
pub(super) trait Backend: Send + 'static {
    /// Creates the render context, with the backend's API on this thread.
    fn create(&mut self, core: &Core) -> Result<*mut ffi::RenderContext, String>;
    /// Draws mpv's frame at `size` and returns it. `timing` holds the render parameters that
    /// turn off mpv's own wait for the due time; the backend adds its own and the end marker.
    fn draw(
        &mut self,
        core: &Core,
        context: *mut ffi::RenderContext,
        size: (u32, u32),
        timing: &[ffi::RenderParam],
    ) -> Result<Picture, String>;
    /// Lets go of what the last file's frames needed, once the core has no file: an idle
    /// engine then holds little more than its shaders.
    fn trim(&mut self, _core: &Core, _context: *mut ffi::RenderContext) {}
    /// Releases what `create` made, after the render context is freed.
    fn destroy(&mut self) {}
}

/// What the render thread and the UI thread share.
pub(super) struct Shared {
    updated: Mutex<bool>,
    wake: Condvar,
    stop: AtomicBool,
    /// Frames drawn and not yet taken, oldest first.
    queue: Mutex<VecDeque<Rendered>>,
    failed: Mutex<Option<String>>,
    /// The window's display refresh, in nanoseconds, as the UI last saw it.
    refresh_ns: AtomicI64,
    /// A fixed lead to use instead of the one worked out, in nanoseconds, or -1.
    lead_override_ns: i64,
    /// Frames drawn so far, taken or not.
    drawn: AtomicU64,
    /// When the newest frames' draws began, by number: mpv takes a frame then.
    begun: Mutex<VecDeque<(u64, Instant)>>,
    /// The longest side frames are drawn at, in pixels, or 0 for the picture's own size: a
    /// gallery tile's preview needs no more than the tile shows.
    max_side: AtomicU32,
    /// Counts the files the core has been given, so frames of the last one are told apart.
    generation: AtomicU64,
    /// [`Self::drawn`] when the current file began.
    drawn_before: AtomicU64,
    /// A file to load and whether with its sound, for the render thread to hand mpv once its
    /// render context exists (mpv's video output starts only with one), with the generation it
    /// is for: a player gone before its file loaded leaves nothing to load.
    load: Mutex<Option<(u64, String, bool)>>,
    /// Whether the render thread is to trim its backend ([`Backend::trim`]), and whether it
    /// has since the last request.
    trim: (AtomicBool, AtomicBool),
}

impl Shared {
    pub(super) fn new(refresh: Duration, lead_override: Option<Duration>) -> Arc<Self> {
        Arc::new(Self {
            updated: Mutex::new(false),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
            queue: Mutex::new(VecDeque::with_capacity(QUEUED)),
            failed: Mutex::new(None),
            refresh_ns: AtomicI64::new(refresh.as_nanos() as i64),
            lead_override_ns: lead_override.map_or(-1, |lead| lead.as_nanos() as i64),
            drawn: AtomicU64::new(0),
            begun: Mutex::new(VecDeque::with_capacity(BEGUN_KEPT)),
            max_side: AtomicU32::new(0),
            generation: AtomicU64::new(0),
            drawn_before: AtomicU64::new(0),
            load: Mutex::new(None),
            trim: (AtomicBool::new(false), AtomicBool::new(false)),
        })
    }

    /// Has the render thread trim its backend, and waits up to `timeout` for it to have. Only
    /// while the core has no file, as the trim draws (no picture) to have mpv let go.
    pub(super) fn trim(&self, timeout: Duration) -> bool {
        self.trim.1.store(false, Ordering::Release);
        self.trim.0.store(true, Ordering::Release);
        self.notify();
        let asked = Instant::now();
        while !self.trim.1.load(Ordering::Acquire) {
            if asked.elapsed() > timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        true
    }

    /// Starts a new file: frames drawn for the last one are dropped, and so are its size limit
    /// and any failure to draw.
    pub(super) fn begin_file(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.drawn_before
            .store(self.drawn.load(Ordering::Relaxed), Ordering::Relaxed);
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).clear();
        *self.failed.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.max_side.store(0, Ordering::Relaxed);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Has the render thread load `path`, with its sound or without, once its render context
    /// exists.
    pub(super) fn request_load(&self, path: String, sound: bool) {
        *self.load.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((self.generation(), path, sound));
        self.notify();
    }

    /// The file to load, if one waits for the current generation.
    fn take_load(&self) -> Option<(String, bool)> {
        let load = self.load.lock().unwrap_or_else(|p| p.into_inner()).take()?;
        (load.0 == self.generation()).then_some((load.1, load.2))
    }

    /// Draws frames no larger than `max_side` on their longer side, or at the picture's own size
    /// when `None`.
    pub(super) fn set_max_side(&self, max_side: Option<u32>) {
        self.max_side
            .store(max_side.unwrap_or(0), Ordering::Relaxed);
        self.notify();
    }

    /// The size to draw a picture of `size` at: its own, or scaled down to the longest side
    /// allowed, keeping its shape, in even numbers as `420f` buffers want.
    fn draw_size(&self, size: (u32, u32)) -> (u32, u32) {
        let max_side = self.max_side.load(Ordering::Relaxed);
        let longer = size.0.max(size.1);
        if max_side == 0 || longer <= max_side {
            return size;
        }
        let scale = f64::from(max_side) / f64::from(longer);
        let even = |side: u32| ((f64::from(side) * scale / 2.).round() as u32 * 2).max(2);
        (even(size.0), even(size.1))
    }

    /// The frame to show at the window's next refresh, which is at `shown`: the oldest one
    /// waiting, unless a newer one is due by then, which replaces it unseen. Two frames drawn
    /// within one refresh of each other so reach the screen a refresh apart, not one of them.
    pub(super) fn take(&self, shown: Instant) -> Option<Rendered> {
        let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        let generation = self.generation();
        queue.retain(|frame| frame.generation == generation);
        let mut taken = queue.pop_front()?;
        while queue
            .front()
            .is_some_and(|next| next.due.is_none_or(|due| due <= shown))
        {
            taken = queue.pop_front().expect("a frame is queued");
        }
        Some(taken)
    }

    /// Frames drawn for the current file.
    pub(super) fn drawn(&self) -> u64 {
        self.drawn.load(Ordering::Relaxed) - self.drawn_before.load(Ordering::Relaxed)
    }

    /// The newest frame whose draw began at or before `at`, and after `since`: when mpv sends a
    /// seek's restart once it has taken the seek's first frame (`vo_wait_frame`), that frame.
    pub(super) fn begun_by(&self, since: Instant, at: Instant) -> Option<u64> {
        self.begun
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .rev()
            .find(|(_, began)| *began <= at)
            .filter(|(_, began)| *began >= since)
            .map(|(number, _)| *number)
    }

    pub(super) fn failure(&self) -> Option<String> {
        self.failed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub(super) fn set_refresh(&self, refresh: Duration) {
        self.refresh_ns
            .store(refresh.as_nanos() as i64, Ordering::Relaxed);
    }

    /// How long before a frame's due time to start drawing it, so it reaches the screen then:
    /// the draw itself, half a refresh on average for the window's next frame to take it, and
    /// the refresh after which that frame is on screen.
    fn lead_ns(&self, draw_ns: i64) -> i64 {
        if self.lead_override_ns >= 0 {
            return self.lead_override_ns;
        }
        let refresh = self.refresh_ns.load(Ordering::Relaxed);
        refresh + refresh / 2 + draw_ns + WAKE_SLACK_NS
    }

    /// Asks the render thread to free its context and end.
    pub(super) fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.notify();
    }

    fn notify(&self) {
        *self.updated.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.wake.notify_one();
    }

    /// Waits for an update; false once the thread should stop.
    fn wait(&self) -> bool {
        let mut updated = self.updated.lock().unwrap_or_else(|p| p.into_inner());
        while !*updated && !self.stop.load(Ordering::Acquire) {
            updated = self.wake.wait(updated).unwrap_or_else(|p| p.into_inner());
        }
        *updated = false;
        !self.stop.load(Ordering::Acquire)
    }
}

/// mpv's update callback: wakes the render thread. It must not call mpv, and does not.
unsafe extern "C" fn on_update(context: *mut c_void) {
    // SAFETY: the pointer is the `Shared` the render thread keeps alive until it has freed the
    // render context, after which mpv calls back no more.
    let shared = unsafe { &*context.cast::<Shared>() };
    shared.notify();
}

/// Starts the render thread for `core`. It loads each file [`Shared::request_load`] names, the
/// first once its context exists.
pub(super) fn spawn(
    core: Arc<Core>,
    shared: Arc<Shared>,
    mut backend: impl Backend,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("mpv-render".into())
        .spawn(move || {
            interactive();
            let context = match backend.create(&core) {
                Ok(context) => context,
                Err(why) => {
                    *shared.failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(why);
                    backend.destroy();
                    return;
                }
            };
            let callback_context = SendPtr(Arc::as_ptr(&shared).cast_mut().cast());
            let api = core.api();
            // SAFETY: a live context; `on_update` and its context outlive it (see `on_update`).
            unsafe {
                (api.render_context_set_update_callback)(
                    context,
                    Some(on_update),
                    callback_context.0,
                )
            };
            // The event thread hears the picture's size after mpv's first frame may have come.
            let listener = shared.clone();
            core.on_size_change(Box::new(move || listener.notify()));
            run(&core, &shared, &mut backend, context);
            // SAFETY: freed on the thread that made it, with its API state current, before the
            // core is destroyed (the teardown joins this thread first).
            unsafe { (api.render_context_free)(context) };
            backend.destroy();
        })
        .expect("spawn mpv's render thread")
}

fn run(core: &Core, shared: &Shared, backend: &mut impl Backend, context: *mut ffi::RenderContext) {
    let api = core.api();
    let no_block: c_int = 0;
    let skip: c_int = 1;
    let timing = [ffi::RenderParam::new(
        ffi::RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
        &raw const no_block,
    )];
    // Whether mpv has a current frame of this file, and the size it was last drawn at.
    let (mut current, mut drawn_size) = (false, None);
    let mut generation = shared.generation();
    // A running average of the draw time, in nanoseconds.
    let mut draw_ns = 4_000_000f64;
    while shared.wait() {
        if generation != shared.generation() {
            generation = shared.generation();
            (current, drawn_size) = (false, None);
        }
        if shared.trim.0.swap(false, Ordering::AcqRel) {
            backend.trim(core, context);
            shared.trim.1.store(true, Ordering::Release);
            continue;
        }
        if let Some((path, sound)) = shared.take_load() {
            core.load(&path, sound);
        }
        // SAFETY: a live context, on its render thread.
        let flags = unsafe { (api.render_context_update)(context) };
        let size = core
            .observed()
            .picture_size()
            .map(|size| shared.draw_size(size));
        if flags & ffi::RENDER_UPDATE_FRAME == 0 {
            // No new frame, but the size heard since the last one: rendering with no frame
            // pending redraws mpv's current one. A paused file's only frame comes this way, as
            // it reaches mpv before its size reaches the event thread.
            if current
                && let Some(size) = size.filter(|size| drawn_size != Some(*size))
                && draw(core, shared, backend, context, size, &timing, None).is_some()
            {
                drawn_size = Some(size);
            }
            continue;
        }
        current = true;
        let mut info = ffi::RenderFrameInfo::default();
        // SAFETY: a live context and the struct the parameter names.
        unsafe {
            (api.render_context_get_info)(
                context,
                ffi::RenderParam::new(ffi::RENDER_PARAM_NEXT_FRAME_INFO, &raw mut info),
            )
        };
        let Some(size) = size else {
            // No size yet: take the frame as drawn at once. Waiting for the size would wait on
            // mpv's core, which waits up to 200 ms for this very frame (`vo_libmpv.c`).
            let mut params = [
                timing[0],
                ffi::RenderParam::new(ffi::RENDER_PARAM_SKIP_RENDERING, &raw const skip),
                ffi::RenderParam::END,
            ];
            // SAFETY: a live context and a terminated parameter list.
            unsafe { (api.render_context_render)(context, params.as_mut_ptr()) };
            continue;
        };

        // mpv's own wait ends at the due time; this one ends early enough for the frame to be
        // drawn, taken by the window and shown by then (`Shared::lead_ns`).
        let due = (info.flags & ffi::RENDER_FRAME_INFO_PRESENT != 0
            && info.flags & ffi::RENDER_FRAME_INFO_REDRAW == 0
            && info.target_time > 0)
            .then(|| {
                let now_ns = core.now_ns();
                let now = Instant::now();
                let until_due = nanoseconds_until(info.target_time, now_ns);
                let wake = until_due - shared.lead_ns(draw_ns as i64);
                if wake > 0 {
                    std::thread::sleep(Duration::from_nanos(wake as u64).min(MAX_WAIT));
                }
                if until_due >= 0 {
                    now + Duration::from_nanos(until_due as u64)
                } else {
                    now - Duration::from_nanos(until_due.unsigned_abs())
                }
            });
        // A seek during the sleep drops the frame; drawing now would redraw the old picture
        // and pass it off as the seek's.
        if !frame_pending(core, context) {
            continue;
        }
        if let Some(took) = draw(core, shared, backend, context, size, &timing, due) {
            drawn_size = Some(size);
            draw_ns += (took.as_nanos() as f64 - draw_ns) * DRAW_WEIGHT;
        }
    }
}

/// Whether mpv has a frame waiting to be drawn.
fn frame_pending(core: &Core, context: *mut ffi::RenderContext) -> bool {
    let mut info = ffi::RenderFrameInfo::default();
    // SAFETY: a live context and the struct the parameter names.
    unsafe {
        (core.api().render_context_get_info)(
            context,
            ffi::RenderParam::new(ffi::RENDER_PARAM_NEXT_FRAME_INFO, &raw mut info),
        )
    };
    info.flags & ffi::RENDER_FRAME_INFO_PRESENT != 0
}

/// Draws mpv's frame (the next one, or the current one again when none is pending) and leaves
/// it for the UI, as a frame of the file begun last. Returns how long the draw took, if it drew.
fn draw(
    core: &Core,
    shared: &Shared,
    backend: &mut impl Backend,
    context: *mut ffi::RenderContext,
    size: (u32, u32),
    timing: &[ffi::RenderParam],
    due: Option<Instant>,
) -> Option<Duration> {
    let generation = shared.generation();
    let started = Instant::now();
    let number = shared.drawn.load(Ordering::Relaxed) + 1;
    {
        let mut begun = shared.begun.lock().unwrap_or_else(|p| p.into_inner());
        if begun.len() == BEGUN_KEPT {
            begun.pop_front();
        }
        begun.push_back((number, started));
    }
    match backend.draw(core, context, size, timing) {
        Ok(picture) => {
            let draw_time = started.elapsed();
            let rendered = Rendered {
                picture,
                due,
                generation,
                rendered_at: Instant::now(),
                number,
                draw_time,
            };
            let mut queue = shared.queue.lock().unwrap_or_else(|p| p.into_inner());
            if queue.len() == QUEUED {
                queue.pop_front();
            }
            queue.push_back(rendered);
            drop(queue);
            shared.drawn.fetch_add(1, Ordering::Relaxed);
            Some(draw_time)
        }
        Err(why) => {
            log::error!("mpv could not draw a frame: {why}");
            *shared.failed.lock().unwrap_or_else(|p| p.into_inner()) = Some(why);
            None
        }
    }
}

/// Marks the calling thread as doing work the user waits on. macOS coalesces the timers of
/// threads at the default class, and a frame's sleep then ended 2 to 10 ms late; at this class it
/// ends within a fraction of a millisecond.
fn interactive() {
    #[cfg(target_os = "macos")]
    {
        /// `QOS_CLASS_USER_INTERACTIVE` in `<sys/qos.h>`.
        const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(class: u32, relative_priority: c_int) -> c_int;
        }
        // SAFETY: changes only the calling thread's scheduling class.
        unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
    }
}

/// Nanoseconds from `now_ns` (`mpv_get_time_ns`) to a frame's `target_time`. `render.h` gives
/// that in microseconds, but since mpv 0.37 moved its clock to nanoseconds `vo_libmpv.c` hands
/// out `mp_time_ns()` as it is (v0.41.0 does). Whichever reading falls within a minute of now
/// is the one this libmpv uses.
fn nanoseconds_until(target_time: i64, now_ns: i64) -> i64 {
    const MINUTE_NS: i64 = 60_000_000_000;
    let as_ns = target_time - now_ns;
    if as_ns.abs() < MINUTE_NS {
        as_ns
    } else {
        target_time.saturating_mul(1000) - now_ns
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A preview's frames keep the picture's shape at the size allowed, never larger than the
    /// picture itself.
    #[test]
    fn previews_draw_at_the_size_allowed() {
        let shared = Shared::new(Duration::from_millis(8), None);
        assert_eq!(shared.draw_size((3840, 2160)), (3840, 2160));
        shared.set_max_side(Some(480));
        assert_eq!(shared.draw_size((3840, 2160)), (480, 270));
        assert_eq!(shared.draw_size((1080, 1920)), (270, 480));
        assert_eq!(shared.draw_size((320, 180)), (320, 180));
    }

    /// mpv v0.41.0 states the due time in nanoseconds; its header and older mpvs, in µs.
    #[test]
    fn reads_the_due_time_in_either_unit() {
        let now_ns = 5_000_000_000_000;
        assert_eq!(nanoseconds_until(now_ns + 20_000_000, now_ns), 20_000_000);
        assert_eq!(
            nanoseconds_until(now_ns / 1000 + 20_000, now_ns),
            20_000_000
        );
        assert_eq!(nanoseconds_until(now_ns - 4_000_000, now_ns), -4_000_000);
    }
}
