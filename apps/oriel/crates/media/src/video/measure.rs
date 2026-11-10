//! What the libmpv spike reads of a player beyond what the app needs: its timings, which libmpv
//! plays it, mpv's own counters, and the picture's pixels. Built only with the `measure` feature.

use std::ffi::CStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::client::Core;
use super::render::{Picture, Shared};
use super::{EngineOptions, Player, Render, SeekMode};

/// Where a player reports its timings, for measuring it: see [`Player::time_with`].
pub trait Timings {
    /// mpv read the file (`MPV_EVENT_FILE_LOADED`), this long after the open.
    fn ready(&mut self, after_open: Duration);
    /// A picture was handed to the window.
    fn frame(&mut self, frame: FrameTiming);
    /// A seek's picture was handed to the window.
    fn seek(&mut self, seek: SeekTiming);
}

/// One picture handed to the window.
#[derive(Clone, Copy, Debug)]
pub struct FrameTiming {
    pub at: Instant,
    pub after_open: Duration,
    /// mpv's `time-pos` when the picture was taken: its time, give or take the frame mpv has
    /// queued behind it.
    pub position: Option<Duration>,
    /// The picture's time less the sound's when it is on screen, in seconds: above zero the
    /// picture is early. It is mpv's own A/V difference (`avsync`) plus how far the picture
    /// reached the screen after the time mpv meant; `None` without sound or for a redraw.
    pub lead: Option<f64>,
    /// How long after mpv's due time the picture reaches the screen, in seconds.
    pub late: Option<f64>,
    /// How long the backend took to draw it, conversion included.
    pub draw: Duration,
    /// How long it waited for the window's next frame.
    pub waited: Duration,
}

/// One seek: where it was asked to go, where mpv says it landed, and how long its picture took.
#[derive(Clone, Copy, Debug)]
pub struct SeekTiming {
    pub mode: SeekMode,
    pub target: Duration,
    /// mpv's `time-pos` when it finished the seek: the time of its first frame.
    pub landed: Option<Duration>,
    /// From the request to the seek's first picture handed to the window.
    pub took: Duration,
    /// From the request to mpv's `MPV_EVENT_PLAYBACK_RESTART`.
    pub finished: Duration,
}

/// A player's engine, read from outside the player: the spike keeps one for a player it has
/// handed to a view. Its reads wait on mpv's core, so never on the UI's hot path.
pub struct Meter {
    core: Arc<Core>,
    shared: Arc<Shared>,
    render: Render,
}

impl Player {
    /// Reports the player's timings to `timings` from now on.
    pub fn time_with(&mut self, timings: Box<dyn Timings>) {
        self.timings = Some(timings);
    }

    pub fn meter(&self) -> Meter {
        Meter {
            core: self.core.clone(),
            shared: self.shared.clone(),
            render: self
                .engine
                .as_ref()
                .map_or(EngineOptions::default().render, |engine| engine.render()),
        }
    }

    /// The picture on screen as 8-bit RGB, width, height and rows, as GPUI's renderer turns it
    /// into colours: for measuring which frame a seek landed on and how true its colours are.
    pub fn picture_rgb(&self) -> Option<(u32, u32, Vec<u8>)> {
        self.frame.as_ref()?.picture.rgb()
    }
}

impl Meter {
    /// Which libmpv, mpv and FFmpeg play this.
    pub fn describe_engine(&self) -> String {
        let api = self.core.api();
        format!(
            "{} (client API {}, {}), FFmpeg {}, from {}",
            self.core.get_string(c"mpv-version").unwrap_or_default(),
            api.client_api(),
            match self.render {
                Render::OpenGl => "OpenGL render API",
                Render::Software => "software render API",
            },
            self.core.get_string(c"ffmpeg-version").unwrap_or_default(),
            api.path.display(),
        )
    }

    /// One of mpv's properties as a number.
    pub fn read_number(&self, name: &CStr) -> Option<f64> {
        self.core.get_double(name)
    }

    /// The decoder in use: "videotoolbox" when the hardware decodes, "no" when the CPU does.
    pub fn hardware_decoder(&self) -> Option<String> {
        self.core.get_string(c"hwdec-current")
    }

    /// The picture's size in pixels as it is shown, once mpv knows it.
    pub fn picture_size(&self) -> Option<(u32, u32)> {
        self.core.observed().picture_size()
    }

    /// Frames the render thread has drawn for this file; those the window never took were
    /// replaced by a newer one before its next refresh.
    pub fn frames_drawn(&self) -> u64 {
        self.shared.drawn()
    }
}

impl Picture {
    /// The picture as 8-bit RGB rows, as GPUI puts it on screen: BGRA as it is, and `420f`
    /// through the BT.601 full-range matrix of GPUI's surface shader, with chroma taken from
    /// the nearest sample. For measurements: it reads every pixel on the CPU.
    fn rgb(&self) -> Option<(u32, u32, Vec<u8>)> {
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
