//! The AVFoundation side: an `AVPlayer` for one file, with an `AVPlayerItemVideoOutput` that hands
//! out its pictures as IOSurface-backed `CVPixelBuffer`s in the one format GPUI's `surface()`
//! draws.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{AnyThread as _, MainThreadMarker};
use objc2_av_foundation::{
    AVPlayer, AVPlayerActionAtItemEnd, AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput,
    AVPlayerStatus, AVVideoColorPrimaries_ITU_R_709_2, AVVideoColorPrimariesKey,
    AVVideoColorPropertiesKey, AVVideoTransferFunction_ITU_R_709_2, AVVideoTransferFunctionKey,
    AVVideoYCbCrMatrix_ITU_R_601_4, AVVideoYCbCrMatrixKey,
};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_media::{CMTime, CMTimeFlags, kCMTimeInvalid, kCMTimePositiveInfinity, kCMTimeZero};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetPixelFormatType, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferMetalCompatibilityKey, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};
use objc2_quartz_core::CACurrentMediaTime;

use super::{VideoError, VideoStatus};

/// GPUI's Metal renderer draws a surface from exactly this format, two planes it samples as
/// R8 and RG8, and asserts on anything else: a buffer in another format would end the app.
const SURFACE_FORMAT: u32 = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
/// Fine enough for any frame rate a file has (it is a multiple of 24, 25, 30, 50 and 60).
const TIMESCALE: i32 = 90_000;

pub(super) struct AvPlayer {
    player: Retained<AVPlayer>,
    item: Retained<AVPlayerItem>,
    output: Retained<AVPlayerItemVideoOutput>,
}

impl AvPlayer {
    pub(super) fn open(path: &Path) -> Result<Self, VideoError> {
        let main_thread =
            MainThreadMarker::new().ok_or(VideoError::Unavailable("off the main thread"))?;
        let url = NSURL::from_file_path(path).ok_or_else(|| VideoError::Failed {
            code: 0,
            message: "its path is not a file URL".into(),
        })?;

        // SAFETY: the settings hold CoreVideo's and AVFoundation's keys with the value types
        // their documentation gives, and every object here is used on the main thread only.
        unsafe {
            let output = AVPlayerItemVideoOutput::initWithOutputSettings(
                AVPlayerItemVideoOutput::alloc(),
                Some(&output_settings()),
            );
            let item = AVPlayerItem::playerItemWithURL(&url, main_thread);
            item.addOutput(&output);
            let player = AVPlayer::playerWithPlayerItem(Some(&item), main_thread);
            player.setActionAtItemEnd(AVPlayerActionAtItemEnd::Pause);
            Ok(Self {
                player,
                item,
                output,
            })
        }
    }

    pub(super) fn status(&self) -> VideoStatus {
        // SAFETY: plain property reads on the main thread.
        unsafe {
            if self.player.status() == AVPlayerStatus::Failed {
                return VideoStatus::Failed(failure(self.player.error()));
            }
            match self.item.status() {
                AVPlayerItemStatus::ReadyToPlay => VideoStatus::Ready,
                AVPlayerItemStatus::Failed => VideoStatus::Failed(failure(self.item.error())),
                _ => VideoStatus::Loading,
            }
        }
    }

    pub(super) fn play(&self) {
        // SAFETY: AVPlayer's own play, on the main thread.
        unsafe { self.player.play() }
    }

    pub(super) fn pause(&self) {
        // SAFETY: as above.
        unsafe { self.player.pause() }
    }

    pub(super) fn rate(&self) -> f32 {
        // SAFETY: a property read.
        unsafe { self.player.rate() }
    }

    pub(super) fn set_rate(&self, rate: f32) {
        // SAFETY: a property write; AVPlayer accepts any rate the item can play.
        unsafe { self.player.setRate(rate) }
    }

    pub(super) fn default_rate(&self) -> f32 {
        // SAFETY: a property read.
        unsafe { self.player.defaultRate() }
    }

    pub(super) fn set_default_rate(&self, rate: f32) {
        // SAFETY: a property write; `play` starts at this rate.
        unsafe { self.player.setDefaultRate(rate) }
    }

    pub(super) fn current_time(&self) -> Duration {
        // SAFETY: a property read.
        duration_of(unsafe { self.player.currentTime() }).unwrap_or_default()
    }

    pub(super) fn duration(&self) -> Option<Duration> {
        // SAFETY: a property read; it is indefinite until the item is ready.
        duration_of(unsafe { self.item.duration() })
    }

    pub(super) fn presentation_size(&self) -> (f64, f64) {
        // SAFETY: a property read; zero until the item is ready, and for sound alone.
        let size = unsafe { self.item.presentationSize() };
        (size.width, size.height)
    }

    pub(super) fn volume(&self) -> f32 {
        // SAFETY: a property read.
        unsafe { self.player.volume() }
    }

    pub(super) fn set_volume(&self, volume: f32) {
        // SAFETY: a property write, in AVPlayer's 0 to 1.
        unsafe { self.player.setVolume(volume) }
    }

    pub(super) fn is_muted(&self) -> bool {
        // SAFETY: a property read.
        unsafe { self.player.isMuted() }
    }

    pub(super) fn set_muted(&self, muted: bool) {
        // SAFETY: a property write.
        unsafe { self.player.setMuted(muted) }
    }

    /// Seeks to `target`, landing anywhere before it (to the keyframe there) when
    /// `any_before`, and anywhere after it when `any_after`, and records `generation` in
    /// `finished` when AVPlayer finishes or abandons the seek.
    pub(super) fn seek(
        &self,
        target: Duration,
        any_before: bool,
        any_after: bool,
        generation: u64,
        finished: Arc<AtomicU64>,
    ) {
        let done = RcBlock::new(move |_: Bool| {
            finished.fetch_max(generation, Ordering::Release);
        });
        // SAFETY: the tolerances are CoreMedia's own constants, and the block only touches an
        // atomic, so it is safe to run on whichever queue AVFoundation calls it on.
        unsafe {
            let tolerance = |any: bool| {
                if any {
                    kCMTimePositiveInfinity
                } else {
                    kCMTimeZero
                }
            };
            self.player
                .seekToTime_toleranceBefore_toleranceAfter_completionHandler(
                    cm_time(target),
                    tolerance(any_before),
                    tolerance(any_after),
                    &done,
                );
        }
    }

    /// The picture due `ahead` from now (a display refresh, when the window will show it), if
    /// the output has one it has not handed out yet, with its time in the video.
    pub(super) fn take_frame(
        &self,
        ahead: Duration,
    ) -> Option<(CFRetained<CVPixelBuffer>, Duration)> {
        let host_time = CACurrentMediaTime() + ahead.as_secs_f64();
        // SAFETY: the output's own pull API, on the main thread, with a valid out pointer.
        let (buffer, time) = unsafe {
            let wanted = self.output.itemTimeForHostTime(host_time);
            if !self.output.hasNewPixelBufferForItemTime(wanted) {
                return None;
            }
            let mut shown = kCMTimeInvalid;
            let buffer = self
                .output
                .copyPixelBufferForItemTime_itemTimeForDisplay(wanted, &mut shown)?;
            (buffer, duration_of(shown).or(duration_of(wanted)))
        };
        // The output was asked for IOSurface-backed buffers, which AVFoundation always gives;
        // the format is checked because GPUI's renderer would panic on any other.
        let buffer = CFRetained::from(buffer);
        let format = CVPixelBufferGetPixelFormatType(&buffer);
        if format != SURFACE_FORMAT {
            log::error!(
                "AVPlayer handed out a {} buffer GPUI cannot draw; skipping it",
                fourcc(format)
            );
            return None;
        }
        Some((buffer, time.unwrap_or_default()))
    }

    /// The video's time on AVPlayer's clock, which the sound follows, `ahead` from now.
    pub(super) fn item_time_at(&self, ahead: Duration) -> Duration {
        let host_time = CACurrentMediaTime() + ahead.as_secs_f64();
        // SAFETY: a pure conversion on the output's timebase.
        duration_of(unsafe { self.output.itemTimeForHostTime(host_time) }).unwrap_or_default()
    }
}

/// What the output asks AVFoundation for: GPUI's surface format, on IOSurfaces Metal can read,
/// converted to the colours GPUI's shader assumes.
///
/// GPUI's surface shader turns Y'CbCr into RGB with the BT.601 matrix, whatever the buffer is
/// tagged with. HD video is BT.709, and drawn as it comes its colours are off (on a flat
/// `#20C020`, by 26 levels of green). Asking for BT.601 makes AVFoundation convert each picture
/// (about 4 % of a core for one 1440p60 stream on an M5 Pro), until GPUI reads the tag itself.
fn output_settings() -> Retained<NSDictionary<NSString, AnyObject>> {
    let format = NSNumber::new_u32(SURFACE_FORMAT);
    let surface = NSDictionary::<NSString, AnyObject>::new();
    let metal = NSNumber::new_bool(true);
    // SAFETY: CoreVideo's and AVFoundation's key constants, which both always define.
    unsafe {
        let key = |key: Option<&'static NSString>| key.expect("AVFoundation defines its keys");
        let colour = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                key(AVVideoColorPrimariesKey),
                key(AVVideoTransferFunctionKey),
                key(AVVideoYCbCrMatrixKey),
            ],
            &[
                key(AVVideoColorPrimaries_ITU_R_709_2) as &AnyObject,
                key(AVVideoTransferFunction_ITU_R_709_2),
                key(AVVideoYCbCrMatrix_ITU_R_601_4),
            ],
        );
        let keys = [
            bridged(kCVPixelBufferPixelFormatTypeKey),
            bridged(kCVPixelBufferIOSurfacePropertiesKey),
            bridged(kCVPixelBufferMetalCompatibilityKey),
            key(AVVideoColorPropertiesKey),
        ];
        let objects: [&AnyObject; 4] = [&format, &surface, &metal, &colour];
        NSDictionary::from_slices(&keys, &objects)
    }
}

/// A CoreFoundation string as the Foundation string it is (the two are toll-free bridged).
fn bridged(key: &CFString) -> &NSString {
    // SAFETY: every CFString is an NSString.
    unsafe { &*(key as *const CFString).cast::<NSString>() }
}

fn cm_time(time: Duration) -> CMTime {
    // SAFETY: a pure constructor.
    unsafe { CMTime::with_seconds(time.as_secs_f64(), TIMESCALE) }
}

/// A CMTime as a duration, if it is a number of seconds at all (not invalid or indefinite).
fn duration_of(time: CMTime) -> Option<Duration> {
    let flags = time.flags;
    if !flags.contains(CMTimeFlags::Valid) || flags.intersects(CMTimeFlags::ImpliedValueFlagsMask) {
        return None;
    }
    // SAFETY: a pure conversion.
    let seconds = unsafe { time.seconds() };
    (seconds.is_finite() && seconds >= 0.).then(|| Duration::from_secs_f64(seconds))
}

fn failure(error: Option<Retained<NSError>>) -> VideoError {
    match error {
        Some(error) => VideoError::Failed {
            code: error.code() as i64,
            message: error.localizedDescription().to_string(),
        },
        None => VideoError::Failed {
            code: 0,
            message: "AVFoundation gave no reason".into(),
        },
    }
}

fn fourcc(format: u32) -> String {
    format
        .to_be_bytes()
        .iter()
        .map(|&byte| {
            if byte.is_ascii_graphic() {
                byte as char
            } else {
                '?'
            }
        })
        .collect()
}
