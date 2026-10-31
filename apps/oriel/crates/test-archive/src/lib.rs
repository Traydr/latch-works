//! The archive Tidy's tests scan, made at test time so the repository holds no media.
//!
//! It is glazier-core's differential archive (its `buildDifferentialArchive`, which e2e's Glazier
//! workbench and Spot variants specs drew), rebuilt in Rust: the same paths, dates and kinds of
//! content, so the tests' counts still describe it. Stills are drawn here and written with the
//! `image` crate, the AVIF misnamed `.jpg` goes through the libavif Convert uses, and the clips
//! come from the pinned ffmpeg's lavfi sources. The bytes are not glazier-core's; what the tests
//! check is what Tidy makes of the files, not their hashes.
//!
//! Without the pinned ffmpeg (`cargo run -p oriel-tools --bin fetch-media-tools`) the clips are
//! left out and [`Built::videos`] says so, so a caller can skip what needs them.

use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

pub use image;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::{self, FilterType as ResizeFilter};
use image::{DynamicImage, ExtendedColorType, ImageEncoder as _, Rgba, RgbaImage};
use oriel_avif::{Channels, Libavif, Samples, Still};
use oriel_tools::MediaTools;

/// The width and height of every full-size still.
pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 480;

/// Old enough that a change dropping the original's date would show: 2022-05-06T07:08:09Z.
pub fn original_mtime() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_651_820_889)
}

/// Copies are made later than their originals, as a copy would be: 2023-01-02T03:04:05Z.
pub fn copied_mtime() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_672_628_645)
}

/// What a build could make on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Built {
    /// The clips are there: the pinned ffmpeg was found.
    pub videos: bool,
    /// `photos/cover.jpg` holds an AVIF; without libavif it holds a PNG, which lies about its
    /// type all the same.
    pub avif: bool,
}

impl Built {
    /// How many files the archive holds: eleven of them are the clips and a copy of one.
    pub fn files(&self) -> usize {
        if self.videos { 26 } else { 15 }
    }
}

/// The pinned ffmpeg, or `None` when it has not been fetched.
pub fn ffmpeg() -> Option<PathBuf> {
    MediaTools::locate()
        .ok()
        .map(|tools| tools.ffmpeg().to_path_buf())
}

/// Builds the archive into `archive`, which is created if missing:
///
/// - `photos/`: `sunset.png` with a resized, recompressed `sunset-small.jpg`; `forest.png` with
///   an exact copy, `forest copy.png`; and `cover.jpg`, an AVIF under the wrong extension;
/// - `dup/`: `forest (1).png`, another copy of the forest, and `with-sound-copy.mp4`;
/// - `clips/`: H.264/AAC MP4s with sound (`with-sound.mp4`, and `with-sound-small.mp4`
///   re-encoded smaller), with a silent track and with none; H.264/AAC in MOV; VP9/Opus WebM; an
///   animated GIF; VP9 with alpha; an odd-width WebM; and MPEG-4 Part 2;
/// - `pages/`: one page in three versions (plain, captioned, another face) in `fanbox/`, and
///   another site's copies of two of them in `pixiv/`, which Spot variants tells apart;
/// - `alt/`: two outfits of one picture, variants and nothing else;
/// - AppleDouble junk (`._sunset.png`), a text file and an `empty/` folder.
///
/// Twenty-six files with the clips, fifteen without, when there is no `clips/` either
/// ([`Built::files`]).
pub fn build_archive(archive: &Path) -> Built {
    let at = |rel: &str| archive.join(rel);
    for folder in [
        "photos",
        "dup",
        "empty",
        "pages/fanbox",
        "pages/pixiv",
        "alt",
    ] {
        fs::create_dir_all(at(folder)).expect("the archive's folders");
    }

    // The clips encode in ffmpeg's processes while the stills are drawn here, each on a thread.
    let (videos, avif) = std::thread::scope(|scope| {
        let clips = scope.spawn(|| match ffmpeg() {
            Some(ffmpeg) => {
                build_clips(&ffmpeg, archive);
                true
            }
            None => false,
        });
        scope.spawn(|| {
            let sunset = archive_picture(1);
            save_png(&sunset, &at("photos/sunset.png"), CompressionType::Default);
            save_jpeg(
                &imageops::resize(&sunset, 320, 240, ResizeFilter::Lanczos3),
                &at("photos/sunset-small.jpg"),
                60,
            );
        });
        scope.spawn(|| {
            save_png(
                &archive_picture(2),
                &at("photos/forest.png"),
                CompressionType::Default,
            );
            copy(&at("photos/forest.png"), &at("dup/forest (1).png"));
            copy(&at("photos/forest.png"), &at("photos/forest copy.png"));
        });
        let avif = scope.spawn(|| save_avif_or_png(&archive_picture(3), &at("photos/cover.jpg")));
        // One page in three versions in one folder, and another site's copies of two of them.
        scope.spawn(|| {
            let page = variant_picture(7);
            let captioned = with_caption(&page);
            save_png(
                &page,
                &at("pages/fanbox/101_jp.png"),
                CompressionType::Default,
            );
            save_png(
                &captioned,
                &at("pages/fanbox/101_en.png"),
                CompressionType::Default,
            );
            save_png(
                &with_face(&page),
                &at("pages/fanbox/101_clean.png"),
                CompressionType::Default,
            );
            save_jpeg(
                &imageops::resize(&page, 480, 360, ResizeFilter::Lanczos3),
                &at("pages/pixiv/900_p0.jpg"),
                70,
            );
            // The captioned page's pixels in other bytes: a copy, not an identical file.
            save_png(
                &captioned,
                &at("pages/pixiv/900_p1.png"),
                CompressionType::Fast,
            );
        });
        // Two outfits of another picture, and nothing else.
        scope.spawn(|| {
            let outfit = variant_picture(3);
            save_png(&outfit, &at("alt/outfit-a.png"), CompressionType::Default);
            save_png(
                &with_face(&outfit),
                &at("alt/outfit-b.png"),
                CompressionType::Default,
            );
        });
        fs::write(at("._sunset.png"), "junk").expect("the junk file");
        fs::write(at("notes.txt"), "not media").expect("the text file");
        (
            clips.join().expect("the clips"),
            avif.join().expect("the cover"),
        )
    });

    let mut originals = vec!["photos/sunset.png", "photos/forest.png"];
    let mut copies = vec!["dup/forest (1).png", "photos/forest copy.png"];
    if videos {
        originals.extend([
            "clips/talk.mov",
            "clips/scene.webm",
            "clips/loop.gif",
            "clips/sticker.webm",
            "clips/odd.webm",
            "clips/old.mp4",
        ]);
        copies.push("dup/with-sound-copy.mp4");
    }
    for rel in originals {
        set_mtime(&at(rel), original_mtime());
    }
    for rel in copies {
        set_mtime(&at(rel), copied_mtime());
    }
    Built { videos, avif }
}

/// Builds the clips Shrink's cases change into `archive/clips`: `busy.mp4`, noisy and at a high
/// bitrate, which AV1 shrinks; `lean.mp4`, already at a low bitrate; and `tiny.mp4`, too small
/// to bother with. `false`, with nothing written, without the pinned ffmpeg.
pub fn build_shrink_archive(archive: &Path) -> bool {
    let Some(ffmpeg) = ffmpeg() else {
        return false;
    };
    let clips = archive.join("clips");
    fs::create_dir_all(&clips).expect("the shrink archive's folder");
    let clip = |name: &str, picture: &str, seconds: u32, rate: &[&str]| {
        let tone = format!("sine=frequency=440:duration={seconds}");
        let length = seconds.to_string();
        let target = clips.join(name);
        let mut args = vec![
            "-f", "lavfi", "-i", picture, "-f", "lavfi", "-i", &tone, "-t", &length, "-c:v",
            "libx264",
        ];
        args.extend_from_slice(rate);
        args.extend([
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "16k",
            "-shortest",
        ]);
        start_ffmpeg(&ffmpeg, &args, &target)
    };
    let encodes = [
        clip(
            "busy.mp4",
            "testsrc2=s=320x180:r=30,noise=alls=24:allf=t",
            1,
            &["-crf", "18"],
        ),
        clip("lean.mp4", "mandelbrot=s=640x360:r=30", 2, &["-b:v", "40k"]),
        clip("tiny.mp4", "mandelbrot=s=320x180:r=30", 1, &["-b:v", "8k"]),
    ];
    for encode in encodes {
        encode.finish();
    }
    true
}

fn build_clips(ffmpeg: &Path, archive: &Path) {
    fs::create_dir_all(archive.join("clips")).expect("the clips' folder");
    let clip = |name: &str| archive.join("clips").join(name);
    let pattern = |source: &str| {
        vec![
            "-f".to_owned(),
            "lavfi".to_owned(),
            "-i".to_owned(),
            format!("{source}=s=320x240:d=3:r=12"),
        ]
    };
    let words = |words: &[&str]| {
        words
            .iter()
            .map(|word| (*word).to_owned())
            .collect::<Vec<_>>()
    };
    let tone = words(&["-f", "lavfi", "-i", "sine=frequency=440:duration=3"]);
    let h264 = words(&["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    let with_sound = [
        pattern("testsrc2"),
        tone.clone(),
        h264.clone(),
        words(&["-c:a", "aac", "-shortest"]),
    ]
    .concat();
    let silent_track = [
        pattern("smptebars"),
        words(&["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
        h264.clone(),
        words(&["-c:a", "aac", "-t", "3"]),
    ]
    .concat();
    let no_audio = [
        words(&["-f", "lavfi", "-i", "mandelbrot=s=320x240:r=12", "-t", "3"]),
        h264.clone(),
    ]
    .concat();
    let talk = [
        pattern("zoneplate"),
        tone.clone(),
        h264.clone(),
        words(&["-c:a", "aac", "-shortest"]),
    ]
    .concat();
    let scene = [
        pattern("yuvtestsrc"),
        tone,
        words(&[
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "300k",
            "-c:a",
            "libopus",
            "-shortest",
        ]),
    ]
    .concat();
    let encodes = [
        (with_sound, "with-sound.mp4"),
        (silent_track, "silent-track.mp4"),
        (no_audio, "no-audio.mp4"),
        (talk, "talk.mov"),
        (scene, "scene.webm"),
        (
            words(&[
                "-f",
                "lavfi",
                "-i",
                "colorspectrum=s=200x150:d=2:r=10",
                "-vf",
                "split[a][b];[a]palettegen[p];[b][p]paletteuse",
            ]),
            "loop.gif",
        ),
        // Videos WebCodecs stumbled on in Electron Oriel: VP9 with an alpha channel, an odd
        // frame width, and MPEG-4 Part 2.
        (
            words(&[
                "-f",
                "lavfi",
                "-i",
                "cellauto=s=450x600:rate=25",
                "-t",
                "2",
                "-vf",
                "format=yuva420p",
                "-c:v",
                "libvpx-vp9",
                "-auto-alt-ref",
                "0",
                "-b:v",
                "300k",
            ]),
            "sticker.webm",
        ),
        (
            words(&[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=720x540:rate=25",
                "-t",
                "2",
                "-vf",
                "scale=717:534",
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "300k",
            ]),
            "odd.webm",
        ),
        (
            words(&[
                "-f",
                "lavfi",
                "-i",
                "rgbtestsrc=s=640x360:d=2:r=25",
                "-c:v",
                "mpeg4",
            ]),
            "old.mp4",
        ),
    ];
    let running: Vec<_> = encodes
        .iter()
        .map(|(args, name)| start_ffmpeg(ffmpeg, args, &clip(name)))
        .collect();
    for encode in running {
        encode.finish();
    }

    // The same footage again, re-encoded smaller: a similar version of with-sound.mp4.
    let source = clip("with-sound.mp4").to_string_lossy().into_owned();
    let small = [
        vec![
            "-i".to_owned(),
            source,
            "-vf".to_owned(),
            "scale=240:180".to_owned(),
        ],
        h264,
        words(&["-crf", "35", "-c:a", "aac"]),
    ]
    .concat();
    start_ffmpeg(ffmpeg, &small, &clip("with-sound-small.mp4")).finish();
    copy(
        &clip("with-sound.mp4"),
        &archive.join("dup/with-sound-copy.mp4"),
    );
}

/// An ffmpeg encode under way.
struct Encode {
    child: std::process::Child,
    target: PathBuf,
}

impl Encode {
    /// Waits for the encode; fails the test with ffmpeg's errors when it did not succeed.
    fn finish(self) {
        let output = self
            .child
            .wait_with_output()
            .unwrap_or_else(|error| panic!("ffmpeg went away: {error}"));
        assert!(
            output.status.success(),
            "ffmpeg could not make {}: {}",
            self.target.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn start_ffmpeg(ffmpeg: &Path, args: &[impl AsRef<std::ffi::OsStr>], target: &Path) -> Encode {
    let child = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(args)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("Could not run {}: {error}", ffmpeg.display()));
    Encode {
        child,
        target: target.to_path_buf(),
    }
}

fn copy(from: &Path, to: &Path) {
    fs::copy(from, to).unwrap_or_else(|error| panic!("Could not copy {}: {error}", from.display()));
}

/// Sets a file's modification time, as a copy that kept its date would have it.
pub fn set_mtime(path: &Path, time: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(time))
        .unwrap_or_else(|error| panic!("Could not date {}: {error}", path.display()));
}

/// Writes a still as an 8-bit RGBA PNG, at `compression`: two compressions of one picture hold
/// the same pixels in different bytes.
pub fn save_png(picture: &RgbaImage, path: &Path, compression: CompressionType) {
    let file = fs::File::create(path)
        .unwrap_or_else(|error| panic!("Could not create {}: {error}", path.display()));
    PngEncoder::new_with_quality(BufWriter::new(file), compression, FilterType::Adaptive)
        .write_image(
            picture.as_raw(),
            picture.width(),
            picture.height(),
            ExtendedColorType::Rgba8,
        )
        .unwrap_or_else(|error| panic!("Could not write {}: {error}", path.display()));
}

/// Writes a still as a baseline JPEG at `quality`, without its alpha, which is opaque anyway.
pub fn save_jpeg(picture: &RgbaImage, path: &Path, quality: u8) {
    let file = fs::File::create(path)
        .unwrap_or_else(|error| panic!("Could not create {}: {error}", path.display()));
    let rgb = DynamicImage::ImageRgba8(picture.clone()).to_rgb8();
    JpegEncoder::new_with_quality(BufWriter::new(file), quality)
        .encode_image(&rgb)
        .unwrap_or_else(|error| panic!("Could not write {}: {error}", path.display()));
}

/// Writes a still as an AVIF at the archive's settings, or as a PNG when libavif is missing;
/// `true` for an AVIF.
fn save_avif_or_png(picture: &RgbaImage, path: &Path) -> bool {
    let encoded = Libavif::get().and_then(|libavif| {
        libavif.encode_archive(
            &Still {
                width: picture.width(),
                height: picture.height(),
                channels: Channels::Rgba,
                samples: Samples::Eight(picture.as_raw()),
            },
            1,
        )
    });
    match encoded {
        Ok(bytes) => {
            fs::write(path, bytes)
                .unwrap_or_else(|error| panic!("Could not write {}: {error}", path.display()));
            true
        }
        Err(_) => {
            save_png(picture, path, CompressionType::Default);
            false
        }
    }
}

/// e2e's workbench picture: a fill, a translucent disc and a bar, each placed by `seed`.
pub fn archive_picture(seed: u32) -> RgbaImage {
    let fill = hsl(seed as f32 * 47.0, 0.70, 0.45);
    let mut picture = RgbaImage::from_pixel(WIDTH, HEIGHT, Rgba([fill[0], fill[1], fill[2], 255]));
    let (cx, cy, r) = (100.0 + seed as f32 * 60.0, 200.0, 90.0);
    fill_shape(
        &mut picture,
        (cx - r, cy - r, cx + r, cy + r),
        WHITE,
        0x99 as f32 / 255.0,
        |x, y| (x - cx).powi(2) + (y - cy).powi(2) <= r * r,
    );
    let x = seed as f32 * 40.0;
    fill_rect(
        &mut picture,
        (x, 320.0, 200.0, 80.0),
        BLACK,
        0x88 as f32 / 255.0,
    );
    picture
}

/// e2e's Spot variants picture: a diagonal gradient, a translucent disc, a bar and a dark curve,
/// each placed by `seed`, with enough structure that a detail print tells an overlay apart.
pub fn variant_picture(seed: u32) -> RgbaImage {
    let from = hsl(((seed * 47) % 360) as f32, 0.70, 0.40);
    let to = hsl(((seed * 47 + 160) % 360) as f32, 0.60, 0.70);
    let mut picture = RgbaImage::new(WIDTH, HEIGHT);
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
        // An objectBoundingBox gradient from the top left corner to the bottom right one.
        let t = ((x as f32 + 0.5) / WIDTH as f32 + (y as f32 + 0.5) / HEIGHT as f32) / 2.0;
        let channel = |index: usize| {
            (f32::from(from[index]) + (f32::from(to[index]) - f32::from(from[index])) * t).round()
                as u8
        };
        *pixel = Rgba([channel(0), channel(1), channel(2), 255]);
    }
    let cx = 120.0 + ((seed * 83) % 400) as f32;
    let cy = 100.0 + ((seed * 61) % 280) as f32;
    let r = 60.0 + (seed % 5) as f32 * 20.0;
    fill_shape(
        &mut picture,
        (cx - r, cy - r, cx + r, cy + r),
        WHITE,
        0x88 as f32 / 255.0,
        |x, y| (x - cx).powi(2) + (y - cy).powi(2) <= r * r,
    );
    fill_rect(
        &mut picture,
        (
            ((seed * 37) % 500) as f32,
            300.0,
            140.0,
            40.0 + (seed % 3) as f32 * 30.0,
        ),
        BLACK,
        0x88 as f32 / 255.0,
    );
    let start = 200.0 + (seed % 7) as f32 * 20.0;
    let bend = if seed % 2 == 1 { 0.0 } else { 480.0 };
    stroke_quadratic(
        &mut picture,
        [(0.0, start), (320.0, bend), (640.0, 240.0)],
        18.0,
        [0x22, 0x22, 0x22],
    );
    picture
}

/// The picture with a caption box in the top right, as a translated page adds.
pub fn with_caption(picture: &RgbaImage) -> RgbaImage {
    let mut captioned = picture.clone();
    let (x, y, w, h, radius) = (530.0, 30.0, 70.0, 32.0, 8.0);
    fill_shape(
        &mut captioned,
        (x, y, x + w, y + h),
        WHITE,
        1.0,
        |px, py| {
            let nearest_x = px.clamp(x + radius, x + w - radius);
            let nearest_y = py.clamp(y + radius, y + h - radius);
            px >= x
                && px < x + w
                && py >= y
                && py < y + h
                && (px - nearest_x).powi(2) + (py - nearest_y).powi(2) <= radius * radius
        },
    );
    fill_rect(&mut captioned, (542.0, 42.0, 46.0, 8.0), [0x11; 3], 1.0);
    captioned
}

/// The picture with another face: a dark ellipse on the left.
pub fn with_face(picture: &RgbaImage) -> RgbaImage {
    let mut faced = picture.clone();
    let (cx, cy, rx, ry) = (150.0, 160.0, 30.0, 24.0);
    fill_shape(
        &mut faced,
        (cx - rx, cy - ry, cx + rx, cy + ry),
        [0x11, 0x22, 0x33],
        1.0,
        |x, y| ((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2) <= 1.0,
    );
    faced
}

const WHITE: [u8; 3] = [255; 3];

const BLACK: [u8; 3] = [0; 3];

/// CSS's `hsl()`, as 8-bit sRGB.
fn hsl(hue: f32, saturation: f32, lightness: f32) -> [u8; 3] {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let sector = (hue.rem_euclid(360.0)) / 60.0;
    let second = chroma * (1.0 - (sector % 2.0 - 1.0).abs());
    let (r, g, b) = match sector as u32 {
        0 => (chroma, second, 0.0),
        1 => (second, chroma, 0.0),
        2 => (0.0, chroma, second),
        3 => (0.0, second, chroma),
        4 => (second, 0.0, chroma),
        _ => (chroma, 0.0, second),
    };
    let lift = lightness - chroma / 2.0;
    [r, g, b].map(|channel| ((channel + lift) * 255.0).round() as u8)
}

/// Lays `colour` at `alpha` over every pixel a shape covers, its edges smoothed by sampling each
/// pixel four by four, as an SVG renderer's antialiasing would.
fn fill_shape(
    picture: &mut RgbaImage,
    (left, top, right, bottom): (f32, f32, f32, f32),
    colour: [u8; 3],
    alpha: f32,
    inside: impl Fn(f32, f32) -> bool,
) {
    const SAMPLES: u32 = 4;
    let columns = left.floor().max(0.0) as u32..(right.ceil() as u32).min(picture.width());
    let rows = top.floor().max(0.0) as u32..(bottom.ceil() as u32).min(picture.height());
    for y in rows {
        for x in columns.clone() {
            let mut covered = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    covered += u32::from(inside(px, py));
                }
            }
            if covered > 0 {
                let coverage = covered as f32 / (SAMPLES * SAMPLES) as f32;
                blend(picture.get_pixel_mut(x, y), colour, alpha * coverage);
            }
        }
    }
}

fn fill_rect(
    picture: &mut RgbaImage,
    (x, y, width, height): (f32, f32, f32, f32),
    colour: [u8; 3],
    alpha: f32,
) {
    fill_shape(
        picture,
        (x, y, x + width, y + height),
        colour,
        alpha,
        |px, py| px >= x && px < x + width && py >= y && py < y + height,
    );
}

/// Strokes a quadratic Bézier `width` wide, by laying a disc of that width at many points along
/// it and keeping each pixel's largest coverage.
fn stroke_quadratic(
    picture: &mut RgbaImage,
    [start, control, end]: [(f32, f32); 3],
    width: f32,
    colour: [u8; 3],
) {
    let (columns, rows) = (picture.width() as usize, picture.height() as usize);
    let mut coverage = vec![0.0f32; columns * rows];
    let radius = width / 2.0;
    const POINTS: usize = 1600;
    for index in 0..=POINTS {
        let t = index as f32 / POINTS as f32;
        let along =
            |a: f32, b: f32, c: f32| (1.0 - t).powi(2) * a + 2.0 * (1.0 - t) * t * b + t * t * c;
        let (cx, cy) = (
            along(start.0, control.0, end.0),
            along(start.1, control.1, end.1),
        );
        let reach = radius + 1.0;
        let x_range =
            (cx - reach).floor().max(0.0) as usize..((cx + reach).ceil() as usize).min(columns);
        let y_range =
            (cy - reach).floor().max(0.0) as usize..((cy + reach).ceil() as usize).min(rows);
        for y in y_range {
            for x in x_range.clone() {
                let distance =
                    ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let covered = (radius + 0.5 - distance).clamp(0.0, 1.0);
                let cell = &mut coverage[y * columns + x];
                *cell = cell.max(covered);
            }
        }
    }
    for (index, &covered) in coverage.iter().enumerate() {
        if covered > 0.0 {
            let (x, y) = ((index % columns) as u32, (index / columns) as u32);
            blend(picture.get_pixel_mut(x, y), colour, covered);
        }
    }
}

/// Source over an opaque pixel.
fn blend(pixel: &mut Rgba<u8>, colour: [u8; 3], alpha: f32) {
    for (channel, &over) in pixel.0.iter_mut().zip(&colour) {
        *channel = (f32::from(*channel) * (1.0 - alpha) + f32::from(over) * alpha).round() as u8;
    }
}
