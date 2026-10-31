//! Plan 063 Phase 1's libmpv spike: libmpv into GPUI, measured on the rows Phase 0 measured on
//! AVPlayer (`video_spike`).
//!
//! ```sh
//! cargo run --release -p oriel-media --example mpv_spike -- single <video>
//! cargo run --release -p oriel-media --example mpv_spike -- tiles <video> [<video> ...]
//! cargo run --release -p oriel-media --example mpv_spike -- sweep <video> [<video> ...]
//! cargo run --release -p oriel-media --example mpv_spike -- errors <video> [<video> ...]
//! cargo run --release -p oriel-media --example mpv_spike -- verify <video> <seconds>...
//! cargo run --release -p oriel-media --example mpv_spike -- colour <video> <rrggbb>
//! cargo run --release -p oriel-media --example mpv_spike -- rest <seconds>
//! ```
//!
//! `ORIEL_RS_MPV_RENDER=sw` measures the software path, else the OpenGL one;
//! `ORIEL_RS_LIBMPV` names a libmpv other than the one `mpv/ffi.rs` finds;
//! `ORIEL_RS_MPV_LEAD_MS` sets how early frames are handed out.
//!
//! `single` plays one file in View's capsule player, switched to libmpv, and drives it as
//! `video_spike` does, keys included (through the window's own key dispatch): the open to the
//! first picture, steady playing, each kind of seek with the A/V lead after it, mute, and warm
//! opens. `tiles` plays up to four files at once, the first with sound. `sweep` opens each file
//! in turn and times its first picture, an exact and a fast seek, with medians per folder.
//! `errors` opens each file and prints what the player makes of it. `verify` seeks a paused
//! player exactly to each time and compares the picture GPUI would draw with the frames
//! Homebrew's ffmpeg decodes around it, to show which frame it landed on. `colour` shows a
//! flat-colour clip beside a GPUI swatch of the colour it was made from and prints the
//! picture's mean colour as GPUI draws it; `rest` opens nothing and prints the footprint every
//! 5 s for that many seconds. With `ORIEL_SPIKE_HOLD=<seconds>` the window stays for a
//! screenshot, with the capsule's volume or speed panel open under
//! `ORIEL_SPIKE_PANEL=volume|speed`.
//!
//! Five switches mirror the gallery: `ORIEL_SPIKE_SILENT=1` opens the sweep's tiles without
//! sound, as a hover preview with sound off plays; `ORIEL_SPIKE_PREWARM=<ms>` starts an engine
//! that long before the first open, as hovering a video tile does; `ORIEL_SPIKE_PRIME=<ms>`
//! starts and primes one that long before, as View showing a folder with videos does;
//! `ORIEL_SPIKE_WARM=<video>` plays that video for a second and closes it first, so `verify` and
//! `colour` run on an engine a player gave back; and `ORIEL_SPIKE_REST=<seconds>` prints the
//! process's footprint and threads once every player has gone, at once and after that rest, to
//! show what idle engines hold.

// The capsule player lives in View's crate, which depends on this one, so the spike builds the
// same file in here rather than depend on View.
#[allow(dead_code)]
#[path = "../../mode-view/src/player.rs"]
mod player;

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, AssetSource, AsyncApp, Bounds, Context, Entity,
    IntoElement, Keystroke, ParentElement as _, Render, Result, SharedString, Styled as _,
    TitlebarOptions, Window, WindowBounds, WindowOptions, div, px, rgb, size,
};
use oriel_media::mpv::{MpvFrameSample, MpvPlayer, MpvRender, pump_frames};
use oriel_media::video::{SeekMode, VideoStatus};
use player::{CapsulePanel, CapsulePlayer, PlayerOptions};

gpui_kit::assets::icon_assets!(PlayerIcons, [RotateCcw, Volume2, VolumeX]);

/// GPUI Kit's default icons with the player's, as `oriel_ui::OrielAssets` has them.
struct SpikeAssets;

impl AssetSource for SpikeAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = PlayerIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(PlayerIcons.list(path)?);
        Ok(paths)
    }
}

const WARM_UP: Duration = Duration::from_secs(2);
const STEADY: Duration = Duration::from_secs(10);
const AFTER_SEEK: Duration = Duration::from_millis(1500);
const FFMPEG: &str = "/opt/homebrew/bin/ffmpeg";

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    let modes = [
        "single", "tiles", "sweep", "errors", "verify", "colour", "rest",
    ];
    if rest.is_empty() || !modes.contains(&mode.as_str()) {
        eprintln!("usage: mpv_spike single|tiles|sweep|errors|verify|colour <file> [...]");
        eprintln!("       mpv_spike rest <seconds>");
        std::process::exit(2);
    }
    // SAFETY: set before any thread starts; the capsule player reads it when it opens.
    unsafe { std::env::set_var("ORIEL_RS_VIDEO", "mpv") };

    gpui_kit::application()
        .with_assets(SpikeAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let options = window_options(cx);
            let (window, root) = gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| Spike::new(&mode, &rest, window, cx))
            })
            .expect("open the spike's window");
            cx.activate(true);
            cx.spawn(async move |cx| {
                let mode = cx.update(|cx| root.read(cx).mode.clone());
                if let Some(lead) = std::env::var("ORIEL_SPIKE_PREWARM")
                    .ok()
                    .and_then(|ms| ms.parse().ok())
                {
                    oriel_media::mpv::prewarm();
                    wait(cx, Duration::from_millis(lead)).await;
                }
                if let Some(lead) = std::env::var("ORIEL_SPIKE_PRIME")
                    .ok()
                    .and_then(|ms| ms.parse().ok())
                {
                    oriel_media::mpv::prime();
                    wait(cx, Duration::from_millis(lead)).await;
                }
                if let Some(warm) = std::env::var_os("ORIEL_SPIKE_WARM") {
                    let tile = cx.new(|_| Tile::new(Path::new(&warm), true, true));
                    wait(cx, Duration::from_secs(1)).await;
                    drop(tile);
                    // Past the audio handover and the core coming to rest.
                    wait(cx, Duration::from_secs(1)).await;
                }
                match mode.as_str() {
                    "single" => run_single(cx, window, &root).await,
                    "tiles" => run_tiles(cx, &root).await,
                    "sweep" => run_sweep(cx, &root).await,
                    "errors" => run_errors(cx, &root).await,
                    "verify" => run_verify(cx, &root).await,
                    "colour" => run_colour(cx, &root).await,
                    "rest" => run_rest(cx, &root).await,
                    _ => {}
                }
                if let Some(hold) = std::env::var("ORIEL_SPIKE_HOLD")
                    .ok()
                    .and_then(|seconds| seconds.parse().ok())
                {
                    // `ORIEL_SPIKE_PANEL=volume` or `speed` opens that capsule panel first, for
                    // a screenshot of it.
                    let panel = match std::env::var("ORIEL_SPIKE_PANEL").as_deref() {
                        Ok("volume") => Some(CapsulePanel::Volume),
                        Ok("speed") => Some(CapsulePanel::Speed),
                        _ => None,
                    };
                    if let Some(panel) = panel {
                        // `single` ends on a tile; the capsule comes back, paused, to show it.
                        let file = cx.update(|cx| PathBuf::from(&root.read(cx).args[0]));
                        window
                            .update(cx, |_, window, cx| {
                                let options = PlayerOptions {
                                    autoplay: false,
                                    ..PlayerOptions::default()
                                };
                                let capsule = cx.new(|cx| {
                                    let mut capsule =
                                        CapsulePlayer::open(file, options, window, cx);
                                    capsule.toggle_panel(panel, cx);
                                    capsule
                                });
                                root.update(cx, |root, cx| {
                                    root.tiles.clear();
                                    root.capsule = Some(capsule);
                                    cx.notify();
                                });
                            })
                            .ok();
                    }
                    println!("holding the window {hold} s, pid {}", std::process::id());
                    wait(cx, Duration::from_secs(hold)).await;
                }
                cx.update(|cx| {
                    root.update(cx, |root, _| {
                        root.capsule = None;
                        root.tiles.clear();
                    })
                });
                wait(cx, Duration::from_millis(300)).await;
                if let Some(rest) = std::env::var("ORIEL_SPIKE_REST")
                    .ok()
                    .and_then(|seconds| seconds.parse().ok())
                {
                    // Past the audio handover and the core coming to rest.
                    wait(cx, Duration::from_secs(1)).await;
                    println!("every player gone: {}", at_rest());
                    wait(cx, Duration::from_secs(rest)).await;
                    println!("{rest} s later: {}", at_rest());
                }
                cx.update(|cx| cx.quit());
            })
            .detach();
        });
}

fn window_options(cx: &mut App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1280.), px(800.)),
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some("Oriel RS libmpv spike".into()),
            ..Default::default()
        }),
        // As in `video_spike`: GPUI caps an inactive window at 30 frames a second otherwise.
        inactive_frame_interval: None,
        ..Default::default()
    }
}

/// The window's content: one capsule player, a grid of tiles, or a tile beside a swatch.
struct Spike {
    mode: String,
    capsule: Option<Entity<CapsulePlayer>>,
    tiles: Vec<Entity<Tile>>,
    swatch: Option<u32>,
    args: Vec<String>,
}

impl Spike {
    fn new(mode: &str, args: &[String], window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut spike = Self {
            mode: mode.into(),
            capsule: None,
            tiles: Vec::new(),
            swatch: None,
            args: args.to_vec(),
        };
        match mode {
            "single" => {
                let path = PathBuf::from(&args[0]);
                let capsule = cx.new(|cx| CapsulePlayer::new(path, window, cx));
                capsule.update(cx, |capsule, _| {
                    if let Some(video) = capsule.mpv_mut() {
                        video.record_samples();
                    }
                });
                spike.capsule = Some(capsule);
            }
            "tiles" => {
                spike.tiles = args
                    .iter()
                    .take(4)
                    .enumerate()
                    .map(|(index, path)| cx.new(|_| Tile::new(Path::new(path), index == 0, true)))
                    .collect();
            }
            "colour" => {
                spike.swatch = args
                    .get(1)
                    .and_then(|hex| u32::from_str_radix(hex.trim_start_matches('#'), 16).ok());
                spike.tiles = vec![cx.new(|_| Tile::new(Path::new(&args[0]), false, false))];
            }
            _ => {}
        }
        spike
    }
}

impl Render for Spike {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let root = div().size_full().bg(gpui_kit::black());
        if let Some(capsule) = &self.capsule {
            return root.child(capsule.clone());
        }
        if let Some(swatch) = self.swatch {
            return root
                .flex()
                .flex_row()
                .child(div().flex_1().h_full().bg(rgb(swatch)))
                .children(
                    self.tiles
                        .iter()
                        .map(|tile| div().flex_1().min_w_0().h_full().child(tile.clone())),
                );
        }
        // Duplicates' tiles: two rows of two.
        let mut rows = self.tiles.chunks(2).map(|row| {
            div().flex().flex_row().flex_1().gap_1().min_h_0().children(
                row.iter()
                    .map(|tile| div().flex_1().min_w_0().h_full().child(tile.clone())),
            )
        });
        let top = rows.next();
        let bottom = rows.next();
        root.flex()
            .flex_col()
            .gap_1()
            .children(top)
            .children(bottom)
    }
}

/// One Duplicates-style tile: the picture alone, no controls.
struct Tile {
    video: Option<MpvPlayer>,
    error: Option<String>,
}

impl Tile {
    fn new(path: &Path, sound: bool, play: bool) -> Self {
        let opened = if std::env::var_os("ORIEL_SPIKE_SILENT").is_some() {
            MpvPlayer::open_silent(path)
        } else {
            MpvPlayer::open_with(path, MpvRender::from_env())
        };
        match opened {
            Ok(mut video) => {
                video.record_samples();
                video.set_muted(!sound);
                if play {
                    video.play();
                }
                Self {
                    video: Some(video),
                    error: None,
                }
            }
            Err(error) => Self {
                video: None,
                error: Some(error.to_string()),
            },
        }
    }

    fn video(&mut self) -> &mut MpvPlayer {
        self.video.as_mut().expect("only an opened tile pumps")
    }
}

impl Render for Tile {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.video.is_some() {
            pump_frames(self, Self::video, window, cx);
        }
        div()
            .size_full()
            .bg(gpui_kit::black())
            .text_color(gpui_kit::white())
            .children(self.video.as_ref().and_then(MpvPlayer::picture))
            .children(self.error.clone())
    }
}

async fn wait(cx: &mut AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

/// Waits up to `timeout` for `check`, looking every 5 ms. The timings come from the player's
/// own samples, so this granularity does not enter them.
async fn wait_for(
    cx: &mut AsyncApp,
    timeout: Duration,
    mut check: impl FnMut(&mut AsyncApp) -> bool,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check(cx) {
            return true;
        }
        wait(cx, Duration::from_millis(5)).await;
    }
    false
}

fn with_capsule<R>(
    cx: &mut AsyncApp,
    capsule: &Entity<CapsulePlayer>,
    read: impl FnOnce(&mut MpvPlayer) -> R,
) -> Option<R> {
    capsule.update(cx, |capsule, cx| {
        cx.notify();
        capsule.mpv_mut().map(read)
    })
}

fn with_tile<R>(
    cx: &mut AsyncApp,
    tile: &Entity<Tile>,
    read: impl FnOnce(&mut MpvPlayer) -> R,
) -> Option<R> {
    tile.update(cx, |tile, cx| {
        cx.notify();
        tile.video.as_mut().map(read)
    })
}

fn press(cx: &mut AsyncApp, window: AnyWindowHandle, key: &'static str) {
    window
        .update(cx, |_, window, cx| {
            window.dispatch_keystroke(Keystroke::parse(key).expect("a key"), cx);
        })
        .expect("the window is open");
}

fn seek_count(video: &MpvPlayer) -> usize {
    video.samples().map_or(0, |s| s.seeks().len())
}

fn clear_frames(video: &mut MpvPlayer) {
    if let Some(samples) = video.samples_mut() {
        samples.clear_frames();
    }
}

async fn run_single(cx: &mut AsyncApp, window: AnyWindowHandle, root: &Entity<Spike>) {
    let capsule = cx
        .update(|cx| root.read(cx).capsule.clone())
        .expect("a capsule");
    let file = cx.update(|cx| PathBuf::from(&root.read(cx).args[0]));
    println!("file {}", file.display());
    let refresh = window
        .update(cx, |_, window, cx| window.refresh_interval(cx))
        .ok()
        .flatten();
    println!("display refresh {refresh:?}");

    let opened = wait_for(cx, Duration::from_secs(10), |cx| {
        with_capsule(cx, &capsule, |video| {
            video
                .samples()
                .and_then(|s| s.first_frame_after())
                .is_some()
                || matches!(video.status(), VideoStatus::Failed(_))
        })
        .unwrap_or(true)
    })
    .await;
    let error = cx.update(|cx| capsule.read(cx).error().map(ToString::to_string));
    if !opened || error.is_some() {
        println!("open failed: {error:?}");
        return;
    }
    let (ready, first, engine) = with_capsule(cx, &capsule, |video| {
        let samples = video.samples().expect("recording");
        (
            samples.ready_after(),
            samples.first_frame_after(),
            video.describe_engine(),
        )
    })
    .expect("an mpv player");
    println!("engine {engine}");
    println!(
        "open: file loaded {} first picture {}",
        ms(ready),
        ms(first)
    );

    wait(cx, WARM_UP).await;
    let decoder = with_capsule(cx, &capsule, |video| video.hardware_decoder()).flatten();
    println!("hwdec-current {decoder:?}");
    steady(cx, "single", std::slice::from_ref(&capsule), &[]).await;

    let seeks: [(&str, Step); 6] = [
        ("exact to 10 s, playing", Step::Seek(10., SeekMode::Exact)),
        ("fast to 3 s, playing", Step::Seek(3., SeekMode::Fast)),
        ("3 skip +5 s", Step::Key("3")),
        ("1 skip −5 s", Step::Key("1")),
        ("exact to 15 s, paused (Space first)", Step::PausedSeek(15.)),
        (
            "exact to 1 s, scrub release",
            Step::Seek(1., SeekMode::Exact),
        ),
    ];
    for (label, step) in seeks {
        let before = with_capsule(cx, &capsule, |v| seek_count(v)).unwrap_or(0);
        with_capsule(cx, &capsule, clear_frames);
        match step {
            Step::Seek(to, mode) => {
                with_capsule(cx, &capsule, |video| {
                    video.seek(Duration::from_secs_f64(to), mode);
                });
            }
            Step::Key(key) => press(cx, window, key),
            Step::PausedSeek(to) => {
                press(cx, window, "space");
                wait(cx, Duration::from_millis(300)).await;
                with_capsule(cx, &capsule, |video| {
                    assert!(!video.is_playing(), "Space paused");
                    video.seek(Duration::from_secs_f64(to), SeekMode::Exact);
                });
            }
        }
        let landed = wait_for(cx, Duration::from_secs(5), |cx| {
            with_capsule(cx, &capsule, |v| seek_count(v)).unwrap_or(0) > before
        })
        .await;
        if !landed {
            println!("seek {label}: no picture in 5 s");
            continue;
        }
        if matches!(step, Step::PausedSeek(_)) {
            press(cx, window, "space");
        }
        // Sync is judged from the landing on, as in `video_spike`.
        with_capsule(cx, &capsule, clear_frames);
        wait(cx, AFTER_SEEK).await;
        let (seek, frames) = with_capsule(cx, &capsule, |video| {
            let samples = video.samples().expect("recording");
            (
                *samples.seeks().last().expect("a seek"),
                samples.frames().to_vec(),
            )
        })
        .expect("a video");
        let after = Sync::of(&frames);
        println!(
            "seek {label}: {:?} target {:.3} s landed {} in {} (mpv done in {}) | then {} \
             pictures, lead mean {:+.1} ms, |lead| p95 {:.1} ms max {:.1} ms",
            seek.mode(),
            seek.target().as_secs_f64(),
            seek.landed()
                .map_or("?".into(), |at| format!("{:.3} s", at.as_secs_f64())),
            ms(Some(seek.took())),
            ms(Some(seek.finished())),
            frames.len(),
            after.lead_mean,
            after.lead_p95,
            after.lead_max,
        );
    }

    press(cx, window, "m");
    let muted = with_capsule(cx, &capsule, |video| video.is_muted()).unwrap_or(false);
    press(cx, window, "m");
    let unmuted = with_capsule(cx, &capsule, |video| !video.is_muted()).unwrap_or(false);
    println!("M mutes: {muted}, M again unmutes: {unmuted}");

    // Warm opens: the same file again, with libmpv and VideoToolbox loaded.
    let mut warm = Vec::new();
    for _ in 0..3 {
        let tile = cx.new(|_| Tile::new(&file, false, false));
        cx.update(|cx| {
            root.update(cx, |root, cx| {
                root.capsule = None;
                root.tiles = vec![tile.clone()];
                cx.notify();
            })
        });
        wait_for(cx, Duration::from_secs(10), |cx| {
            with_tile(cx, &tile, |video| {
                video
                    .samples()
                    .and_then(|s| s.first_frame_after())
                    .is_some()
            })
            .unwrap_or(true)
        })
        .await;
        warm.push(
            with_tile(cx, &tile, |video| {
                video.samples().and_then(|s| s.first_frame_after())
            })
            .flatten(),
        );
        wait(cx, Duration::from_millis(200)).await;
    }
    println!(
        "warm opens to first picture: {}",
        warm.iter().map(|t| ms(*t)).collect::<Vec<_>>().join(", ")
    );
}

enum Step {
    Seek(f64, SeekMode),
    Key(&'static str),
    PausedSeek(f64),
}

async fn run_tiles(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let tiles = cx.update(|cx| root.read(cx).tiles.clone());
    let files = cx.update(|cx| root.read(cx).args.clone());
    for file in files.iter().take(4) {
        println!("tile {file}");
    }
    wait_for(cx, Duration::from_secs(15), |cx| {
        tiles.iter().all(|tile| {
            with_tile(cx, tile, |video| {
                video
                    .samples()
                    .and_then(|s| s.first_frame_after())
                    .is_some()
                    || matches!(video.status(), VideoStatus::Failed(_))
            })
            .unwrap_or(true)
        })
    })
    .await;
    for (index, tile) in tiles.iter().enumerate() {
        let first = with_tile(cx, tile, |v| {
            v.samples().and_then(|s| s.first_frame_after())
        })
        .flatten();
        println!("tile {index}: open to first picture {}", ms(first));
    }
    wait(cx, WARM_UP).await;
    steady(cx, "tiles", &[], &tiles).await;

    // All four seek at once, as a Duplicates group stepping through its files would.
    let before: Vec<usize> = tiles
        .iter()
        .map(|tile| {
            with_tile(cx, tile, |video| {
                video.seek(Duration::from_secs(10), SeekMode::Exact);
                seek_count(video)
            })
            .unwrap_or(0)
        })
        .collect();
    wait_for(cx, Duration::from_secs(5), |cx| {
        tiles
            .iter()
            .zip(&before)
            .all(|(tile, before)| with_tile(cx, tile, |v| seek_count(v) > *before).unwrap_or(true))
    })
    .await;
    for (index, tile) in tiles.iter().enumerate() {
        match with_tile(cx, tile, |v| {
            v.samples().and_then(|s| s.seeks().last().copied())
        })
        .flatten()
        {
            Some(seek) => println!(
                "tile {index}: exact to 10 s together landed {} in {}",
                seek.landed()
                    .map_or("?".into(), |at| format!("{:.3} s", at.as_secs_f64())),
                ms(Some(seek.took()))
            ),
            None => println!("tile {index}: the seek showed no picture"),
        }
    }
}

/// One file of a sweep: its folder, then its first picture, exact seek and fast seek.
type SweepRow = (String, Option<Duration>, Option<Duration>, Option<Duration>);

async fn run_sweep(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let files = cx.update(|cx| root.read(cx).args.clone());
    let mut rows: Vec<SweepRow> = Vec::new();
    for file in files {
        let path = PathBuf::from(&file);
        let folder = path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tile = cx.new(|_| Tile::new(&path, false, true));
        cx.update(|cx| {
            root.update(cx, |root, cx| {
                root.tiles = vec![tile.clone()];
                cx.notify();
            })
        });
        let first = picture_after(cx, &tile, |video| {
            video.samples().and_then(|s| s.first_frame_after())
        })
        .await;
        let Some(first) = first else {
            let error = cx.update(|cx| {
                let tile = tile.read(cx);
                tile.error.clone().or_else(|| {
                    tile.video
                        .as_ref()
                        .and_then(|v| v.error().map(ToString::to_string))
                })
            });
            println!("{file}: no picture ({error:?})");
            rows.push((folder, None, None, None));
            continue;
        };
        wait(cx, Duration::from_millis(300)).await;
        let mut seeks = [None, None];
        let mut landed = [None, None];
        for (slot, (share, mode)) in [(0.5, SeekMode::Exact), (0.25, SeekMode::Fast)]
            .into_iter()
            .enumerate()
        {
            let before = with_tile(cx, &tile, |video| {
                let target = video.duration().unwrap_or_default().mul_f64(share);
                video.seek(target, mode);
                seek_count(video)
            })
            .unwrap_or(0);
            let seek = picture_after(cx, &tile, move |video| {
                video.samples().and_then(|s| s.seeks().get(before).copied())
            })
            .await;
            seeks[slot] = seek.map(|seek| seek.took());
            landed[slot] = seek.map(|seek| (seek.target(), seek.landed()));
            wait(cx, Duration::from_millis(200)).await;
        }
        println!(
            "{file}: first picture {}, exact seek {}{}, fast seek {}",
            ms(Some(first)),
            ms(seeks[0]),
            landed[0].map_or(String::new(), |(target, landed)| format!(
                " (target {:.3} s, landed {})",
                target.as_secs_f64(),
                landed.map_or("?".into(), |at| format!("{:.3} s", at.as_secs_f64()))
            )),
            ms(seeks[1]),
        );
        rows.push((folder, Some(first), seeks[0], seeks[1]));
    }

    let mut folders: Vec<&str> = rows.iter().map(|row| row.0.as_str()).collect();
    folders.sort();
    folders.dedup();
    for folder in folders {
        let of = |pick: fn(&SweepRow) -> Option<Duration>| {
            let mut values: Vec<f64> = rows
                .iter()
                .filter(|row| row.0 == folder)
                .filter_map(pick)
                .map(|d| d.as_secs_f64() * 1000.)
                .collect();
            values.sort_by(f64::total_cmp);
            format!(
                "median {:.0} ms p95 {:.0} ms max {:.0} ms",
                percentile(&values, 0.5),
                percentile(&values, 0.95),
                values.last().copied().unwrap_or(0.)
            )
        };
        let failed = rows
            .iter()
            .filter(|row| row.0 == folder && row.1.is_none())
            .count();
        let total = rows.iter().filter(|row| row.0 == folder).count();
        println!("{folder}: {total} files, {failed} without a picture");
        println!("{folder}: open to first picture {}", of(|row| row.1));
        println!("{folder}: exact seek to its picture {}", of(|row| row.2));
        println!("{folder}: fast seek to its picture {}", of(|row| row.3));
    }
}

/// Waits up to 10 s for `read` to find something in the tile's player.
async fn picture_after<T>(
    cx: &mut AsyncApp,
    tile: &Entity<Tile>,
    read: impl Fn(&MpvPlayer) -> Option<T>,
) -> Option<T> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        let found = cx.update(|cx| {
            let Some(video) = tile.read(cx).video.as_ref() else {
                return Some(None);
            };
            if video.error().is_some() {
                return Some(None);
            }
            read(video).map(Some)
        });
        if let Some(result) = found {
            return result;
        }
        cx.update(|cx| tile.update(cx, |_, cx| cx.notify()));
        wait(cx, Duration::from_millis(5)).await;
    }
    None
}

async fn run_errors(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let files = cx.update(|cx| root.read(cx).args.clone());
    for file in files {
        let start = Instant::now();
        let tile = cx.new(|_| Tile::new(Path::new(&file), true, true));
        cx.update(|cx| {
            root.update(cx, |root, cx| {
                root.tiles = vec![tile.clone()];
                cx.notify();
            })
        });
        let first = picture_after(cx, &tile, |video| {
            video.samples().and_then(|s| s.first_frame_after())
        })
        .await;
        wait(cx, Duration::from_millis(1500)).await;
        let report = cx.update(|cx| {
            let tile = tile.read(cx);
            match &tile.video {
                Some(video) => format!(
                    "{:?}, first picture {}, {:.2} s played, duration {:?}, size {:?}, hwdec {:?}",
                    video.status(),
                    ms(first),
                    video.position().as_secs_f64(),
                    video.duration().map(|d| d.as_secs_f64()),
                    video.picture_size(),
                    video.hardware_decoder(),
                ),
                None => format!("refused: {:?}", tile.error),
            }
        });
        println!("{file}: {report} (after {})", ms(Some(start.elapsed())));
    }
}

/// Seeks a paused player exactly to each time given and finds which of the frames around it,
/// as ffmpeg decodes them, the picture is.
async fn run_verify(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let args = cx.update(|cx| root.read(cx).args.clone());
    let path = PathBuf::from(&args[0]);
    let targets: Vec<f64> = args[1..].iter().filter_map(|t| t.parse().ok()).collect();
    let tile = cx.new(|_| Tile::new(&path, false, false));
    cx.update(|cx| {
        root.update(cx, |root, cx| {
            root.tiles = vec![tile.clone()];
            cx.notify();
        })
    });
    if picture_after(cx, &tile, |v| {
        v.samples().and_then(|s| s.first_frame_after())
    })
    .await
    .is_none()
    {
        println!("{}: no first picture", path.display());
        return;
    }
    let fps = with_tile(cx, &tile, |v| v.read_number(c"container-fps"))
        .flatten()
        .unwrap_or(30.);
    let keyframes = keyframe_times(&path);
    let decoder = with_tile(cx, &tile, |v| v.hardware_decoder()).flatten();
    println!(
        "{}: {fps} fps, hwdec {decoder:?}, render {:?}, keyframes at {:?}",
        path.display(),
        MpvRender::from_env(),
        keyframes
            .iter()
            .map(|t| format!("{t:.3}"))
            .collect::<Vec<_>>()
    );
    for target in targets {
        let before = with_tile(cx, &tile, |video| {
            video.seek(Duration::from_secs_f64(target), SeekMode::Exact);
            seek_count(video)
        })
        .unwrap_or(0);
        let Some(seek) = picture_after(cx, &tile, move |video| {
            video.samples().and_then(|s| s.seeks().get(before).copied())
        })
        .await
        else {
            println!("seek to {target:.3} s: no picture");
            continue;
        };
        // A redraw or two may follow the landing; the picture then is the seek's.
        wait(cx, Duration::from_millis(300)).await;
        let Some((width, height, shown)) = with_tile(cx, &tile, |v| v.picture_rgb()).flatten()
        else {
            println!("seek to {target:.3} s: no picture to read");
            continue;
        };
        let keyframe = keyframes
            .iter()
            .copied()
            .filter(|time| *time <= target + 1e-3)
            .fold(0., f64::max);
        let mut candidates: Vec<(String, f64)> = (-2..=2)
            .map(|step| (format!("frame {:+}", step), target + f64::from(step) / fps))
            .collect();
        candidates.push(("keyframe before".into(), keyframe));
        let mut scores = Vec::new();
        for (name, time) in candidates {
            if let Some(reference) = ffmpeg_frame(&path, time, width, height) {
                scores.push((name, time, mean_abs_difference(&shown, &reference)));
            }
        }
        let best = scores
            .iter()
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .map(|(name, time, _)| format!("{name} ({time:.3} s)"))
            .unwrap_or_default();
        println!(
            "seek to {target:.3} s: landed {} in {}; picture matches {best}; mean |diff| {}",
            seek.landed()
                .map_or("?".into(), |at| format!("{:.3} s", at.as_secs_f64())),
            ms(Some(seek.took())),
            scores
                .iter()
                .map(|(name, _, score)| format!("{name} {score:.2}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
}

/// Opens nothing and prints the process's footprint and threads every 5 s: with
/// `ORIEL_SPIKE_PRIME`, what a primed engine holds while it waits and once it has shut down.
async fn run_rest(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let seconds: u64 = cx
        .update(|cx| root.read(cx).args[0].parse().ok())
        .unwrap_or(40);
    let start = Instant::now();
    println!("pid {}", std::process::id());
    for at in (0..=seconds).step_by(5) {
        let at = Duration::from_secs(at.max(1));
        wait(cx, at.saturating_sub(start.elapsed())).await;
        println!("at {:.0} s: {}", start.elapsed().as_secs_f64(), at_rest());
    }
}

/// Shows the flat-colour clip beside a swatch of its colour and prints its mean colour.
async fn run_colour(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let (args, swatch) = cx.update(|cx| (root.read(cx).args.clone(), root.read(cx).swatch));
    let tile = cx.update(|cx| root.read(cx).tiles[0].clone());
    if picture_after(cx, &tile, |v| {
        v.samples().and_then(|s| s.first_frame_after())
    })
    .await
    .is_none()
    {
        println!("{}: no picture", args[0]);
        return;
    }
    wait(cx, Duration::from_millis(500)).await;
    let Some((width, height, rgb)) = with_tile(cx, &tile, |v| v.picture_rgb()).flatten() else {
        println!("no picture to read");
        return;
    };
    let pixels = (width * height) as usize;
    let mut sums = [0u64; 3];
    let (mut low, mut high) = ([255u8; 3], [0u8; 3]);
    for pixel in rgb.as_chunks::<3>().0 {
        for channel in 0..3 {
            sums[channel] += u64::from(pixel[channel]);
            low[channel] = low[channel].min(pixel[channel]);
            high[channel] = high[channel].max(pixel[channel]);
        }
    }
    let mean = sums.map(|sum| sum as f64 / pixels as f64);
    let expected = swatch.map(|hex| [(hex >> 16) as u8, (hex >> 8) as u8, hex as u8]);
    println!(
        "{} ({:?}): picture {width}x{height}, mean RGB ({:.1}, {:.1}, {:.1}), range {low:?} to \
         {high:?}; made from {expected:?}{}",
        args[0],
        MpvRender::from_env(),
        mean[0],
        mean[1],
        mean[2],
        expected.map_or(String::new(), |expected| format!(
            ", off by ({:+.1}, {:+.1}, {:+.1})",
            mean[0] - f64::from(expected[0]),
            mean[1] - f64::from(expected[1]),
            mean[2] - f64::from(expected[2])
        ))
    );
}

/// The keyframes' times, from ffprobe beside Homebrew's ffmpeg.
fn keyframe_times(path: &Path) -> Vec<f64> {
    let output = Command::new(FFMPEG.replace("ffmpeg", "ffprobe"))
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().trim_end_matches(',').parse().ok())
        .collect()
}

/// The frame at `time` as ffmpeg decodes it, in RGB at `width` by `height`, converted with the
/// BT.709 limited-range matrix mpv uses for HD video that states none.
fn ffmpeg_frame(path: &Path, time: f64, width: u32, height: u32) -> Option<Vec<u8>> {
    let filter = format!(
        "scale={width}:{height}:in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bilinear,\
         format=rgb24"
    );
    let output = Command::new(FFMPEG)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-ss",
            &format!("{time:.6}"),
            "-i",
        ])
        .arg(path)
        .args(["-frames:v", "1", "-vf", &filter, "-f", "rawvideo", "-"])
        .output()
        .ok()?;
    (output.stdout.len() == (width * height * 3) as usize).then_some(output.stdout)
}

fn mean_abs_difference(a: &[u8], b: &[u8]) -> f64 {
    let total: u64 = a
        .iter()
        .zip(b)
        .map(|(a, b)| u64::from(a.abs_diff(*b)))
        .sum();
    total as f64 / a.len().max(1) as f64
}

/// Measures a steady stretch of playing: the pictures each player showed, CPU and memory.
async fn steady(
    cx: &mut AsyncApp,
    label: &str,
    capsules: &[Entity<CapsulePlayer>],
    tiles: &[Entity<Tile>],
) {
    let each = |cx: &mut AsyncApp, read: &mut dyn FnMut(&mut MpvPlayer)| {
        for capsule in capsules {
            with_capsule(cx, capsule, |video| read(video));
        }
        for tile in tiles {
            with_tile(cx, tile, |video| read(video));
        }
    };
    let mut before = Vec::new();
    each(cx, &mut |video| {
        clear_frames(video);
        before.push(Counters::of(video));
    });
    let start = Usage::now();
    wait(cx, STEADY).await;
    let end = Usage::now();
    let wall = end.at.duration_since(start.at).as_secs_f64();

    let mut runs = Vec::new();
    each(cx, &mut |video| {
        let frames = video
            .samples()
            .map(|s| s.frames().to_vec())
            .unwrap_or_default();
        let fps = video.read_number(c"container-fps").unwrap_or(30.);
        runs.push((frames, fps, Counters::of(video)));
    });
    for (index, ((frames, fps, after), before)) in runs.iter().zip(&before).enumerate() {
        let sync = Sync::of(frames);
        let mut intervals: Vec<f64> = frames
            .windows(2)
            .map(|pair| pair[1].at().duration_since(pair[0].at()).as_secs_f64() * 1000.)
            .collect();
        intervals.sort_by(f64::total_cmp);
        let mut draws: Vec<f64> = frames
            .iter()
            .map(|f| f.draw().as_secs_f64() * 1000.)
            .collect();
        draws.sort_by(f64::total_cmp);
        let mut waits: Vec<f64> = frames
            .iter()
            .map(|f| f.waited().as_secs_f64() * 1000.)
            .collect();
        waits.sort_by(f64::total_cmp);
        let span = match (frames.first(), frames.last()) {
            (Some(first), Some(last)) => last.at().duration_since(first.at()).as_secs_f64(),
            _ => 0.,
        };
        println!(
            "{label} #{index} steady {wall:.1} s at {fps:.2} fps: {} pictures of {:.0} expected; \
             {} drawn but never shown; mpv dropped {:.0} in the output, {:.0} in the decoder, \
             delayed {:.0}; interval p50 {:.1} ms p95 {:.1} ms max {:.1} ms; draw p50 {:.2} ms \
             p95 {:.2} ms; slot wait p50 {:.1} ms; lead mean {:+.1} ms, |lead| p95 {:.1} ms \
             max {:.1} ms; late mean {:+.1} ms",
            frames.len(),
            span * fps + 1.,
            (after.drawn - before.drawn).saturating_sub(frames.len() as u64),
            after.vo_drops - before.vo_drops,
            after.decoder_drops - before.decoder_drops,
            after.delayed - before.delayed,
            percentile(&intervals, 0.5),
            percentile(&intervals, 0.95),
            intervals.last().copied().unwrap_or(0.),
            percentile(&draws, 0.5),
            percentile(&draws, 0.95),
            percentile(&waits, 0.5),
            sync.lead_mean,
            sync.lead_p95,
            sync.lead_max,
            sync.late_mean,
        );
    }
    println!(
        "{label} usage: app CPU {:.1} % RSS {} MB; VTDecoderXPCService CPU {:.1} % RSS {} MB \
         ({} processes)",
        (end.cpu - start.cpu).as_secs_f64() / wall * 100.,
        end.rss_kb / 1024,
        (end.decoder_cpu.saturating_sub(start.decoder_cpu)).as_secs_f64() / wall * 100.,
        end.decoder_rss_kb / 1024,
        end.decoders,
    );
}

/// mpv's own counters, read at both ends of a stretch.
struct Counters {
    drawn: u64,
    vo_drops: f64,
    decoder_drops: f64,
    delayed: f64,
}

impl Counters {
    fn of(video: &MpvPlayer) -> Self {
        Self {
            drawn: video.frames_drawn(),
            vo_drops: video.read_number(c"frame-drop-count").unwrap_or(0.),
            decoder_drops: video.read_number(c"decoder-frame-drop-count").unwrap_or(0.),
            delayed: video.read_number(c"vo-delayed-frame-count").unwrap_or(0.),
        }
    }
}

/// What the pictures of a stretch say about sync.
struct Sync {
    lead_mean: f64,
    lead_p95: f64,
    lead_max: f64,
    late_mean: f64,
}

impl Sync {
    fn of(frames: &[MpvFrameSample]) -> Self {
        let leads: Vec<f64> = frames
            .iter()
            .filter_map(|f| f.lead())
            .map(|lead| lead * 1000.)
            .collect();
        let lates: Vec<f64> = frames
            .iter()
            .filter_map(|f| f.late())
            .map(|late| late * 1000.)
            .collect();
        let mut magnitudes: Vec<f64> = leads.iter().map(|lead| lead.abs()).collect();
        magnitudes.sort_by(f64::total_cmp);
        Self {
            lead_mean: leads.iter().sum::<f64>() / leads.len().max(1) as f64,
            lead_p95: percentile(&magnitudes, 0.95),
            lead_max: magnitudes.last().copied().unwrap_or(0.),
            late_mean: lates.iter().sum::<f64>() / lates.len().max(1) as f64,
        }
    }
}

fn percentile(sorted: &[f64], share: f64) -> f64 {
    if sorted.is_empty() {
        return 0.;
    }
    sorted[((sorted.len() - 1) as f64 * share).round() as usize]
}

/// CPU time and resident memory of this process and of VideoToolbox's decoder services, from
/// `ps`, as `video_spike` takes them.
struct Usage {
    at: Instant,
    cpu: Duration,
    rss_kb: u64,
    decoder_cpu: Duration,
    decoder_rss_kb: u64,
    decoders: usize,
}

impl Usage {
    fn now() -> Self {
        let at = Instant::now();
        let output = Command::new("ps")
            .args(["-axo", "pid=,time=,rss=,comm="])
            .output()
            .expect("ps runs");
        let own = std::process::id().to_string();
        let mut usage = Self {
            at,
            cpu: Duration::ZERO,
            rss_kb: 0,
            decoder_cpu: Duration::ZERO,
            decoder_rss_kb: 0,
            decoders: 0,
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut fields = line.split_whitespace();
            let (Some(pid), Some(time), Some(rss)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let command = fields.collect::<Vec<_>>().join(" ");
            let (time, rss) = (cpu_time(time), rss.parse().unwrap_or(0));
            if pid == own {
                usage.cpu = time;
                usage.rss_kb = rss;
            } else if command.contains("VTDecoderXPCService") {
                usage.decoder_cpu += time;
                usage.decoder_rss_kb += rss;
                usage.decoders += 1;
            }
        }
        usage
    }
}

/// The process's footprint, as Activity Monitor's Memory column and `footprint` give it, and its
/// thread count.
fn at_rest() -> String {
    let footprint = phys_footprint();
    let threads = Command::new("ps")
        .args(["-M", "-p", &std::process::id().to_string()])
        .output()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .count()
                .saturating_sub(1)
        })
        .unwrap_or(0);
    format!(
        "footprint {:.1} MB, {threads} threads",
        footprint.unwrap_or(0) as f64 / 1e6
    )
}

#[cfg(target_os = "macos")]
fn phys_footprint() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: `usage` is a `rusage_info_v4`, the flavour asked for.
    let status = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            usage.as_mut_ptr().cast(),
        )
    };
    // SAFETY: zeroed is a valid `rusage_info_v4`, and the call filled it on success.
    (status == 0).then(|| unsafe { usage.assume_init() }.ri_phys_footprint)
}

/// Off macOS the spike reads no footprint yet; the Windows agent measures with Task Manager or
/// `GetProcessMemoryInfo`.
#[cfg(not(target_os = "macos"))]
fn phys_footprint() -> Option<u64> {
    None
}

/// `ps`'s `[[dd-]hh:]mm:ss.cc`.
fn cpu_time(text: &str) -> Duration {
    let seconds = text
        .rsplit(':')
        .zip([1., 60., 3600.])
        .map(|(part, unit)| part.parse::<f64>().unwrap_or(0.) * unit)
        .sum::<f64>();
    Duration::from_secs_f64(seconds)
}

fn ms(duration: Option<Duration>) -> String {
    match duration {
        Some(duration) => format!("{:.0} ms", duration.as_secs_f64() * 1000.),
        None => "none".into(),
    }
}
