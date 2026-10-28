//! Plan 063's Phase 0 video spike: AVPlayer into GPUI's `surface()`, measured.
//!
//! ```sh
//! cargo run -p oriel-media --example video_spike [--release] -- single <video>
//! cargo run -p oriel-media --example video_spike [--release] -- tiles <video> [<video> ...]
//! cargo run -p oriel-media --example video_spike [--release] -- sweep <video> [<video> ...]
//! cargo run -p oriel-media --example video_spike -- errors <video> [<video> ...]
//! cargo run -p oriel-media --example video_spike -- still <png> <video> [<video> ...]
//! ```
//!
//! `single` plays one file in View's capsule player and drives it the way a person would, keys
//! included (they go through the window's own key dispatch, since this Mac allows no scripted
//! keystrokes): it times the open to the first picture, steady playing (pictures shown against
//! expected, dropped, intervals, CPU and memory), and each kind of seek, and checks every
//! picture's time against AVPlayer's clock, which the sound follows. `tiles` plays up to four
//! files at once as Duplicates does, the first with sound. `sweep` opens each file in turn and
//! times its first picture and an exact and a fast seek, with medians per folder (the fixture
//! keeps one folder per codec). `errors` opens each file and prints
//! what the player makes of it. `still` shows a PNG beside the first picture of each video, for
//! a screenshot that compares the video path's colours with GPUI's image path. Set
//! `ORIEL_SPIKE_HOLD=<seconds>` to keep the window open at the end for a screenshot, and
//! `ORIEL_SPIKE_INACTIVE=1` to keep GPUI's default frame cap for inactive windows and measure
//! `single` behind a second, focused window.

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
    IntoElement, Keystroke, ObjectFit, ParentElement as _, Render, Result, SharedString,
    Styled as _, StyledImage as _, TitlebarOptions, Window, WindowBounds, WindowOptions, div, img,
    px, size,
};
use oriel_media::video::{FrameSample, SeekMode, VideoPlayer, VideoStatus, pump_frames};
use player::CapsulePlayer;

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

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    let files: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let modes = ["single", "tiles", "sweep", "errors", "still"];
    if files.is_empty() || !modes.contains(&mode.as_str()) {
        eprintln!("usage: video_spike single|tiles|sweep|errors|still <file>...");
        std::process::exit(2);
    }

    gpui_kit::application()
        .with_assets(SpikeAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            let options = window_options(cx);
            let (window, root) = gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| Spike::new(&mode, &files, window, cx))
            })
            .expect("open the spike's window");
            cx.activate(true);
            cx.spawn(async move |cx| {
                let mode = cx.update(|cx| root.read(cx).mode.clone());
                match mode.as_str() {
                    "single" => run_single(cx, window, &root).await,
                    "tiles" => run_tiles(cx, &root).await,
                    "sweep" => run_sweep(cx, &root).await,
                    "errors" => run_errors(cx, &root).await,
                    _ => wait(cx, Duration::from_secs(3)).await,
                }
                if let Some(hold) = std::env::var("ORIEL_SPIKE_HOLD")
                    .ok()
                    .and_then(|seconds| seconds.parse().ok())
                {
                    println!("holding the window {hold} s, pid {}", std::process::id());
                    wait(cx, Duration::from_secs(hold)).await;
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
            title: Some("Oriel RS video spike".into()),
            ..Default::default()
        }),
        // GPUI caps animation frames at 30 a second in an inactive window by default, which
        // would halve a 60 fps video whenever the window loses focus.
        inactive_frame_interval: if inactive() {
            WindowOptions::default().inactive_frame_interval
        } else {
            None
        },
        ..Default::default()
    }
}

fn inactive() -> bool {
    std::env::var_os("ORIEL_SPIKE_INACTIVE").is_some()
}

/// A small window in front, so the spike's own window is inactive.
struct Cover;

impl Render for Cover {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().bg(gpui_kit::white())
    }
}

/// The window's content: one capsule player, a grid of tiles, or a still beside videos.
struct Spike {
    mode: String,
    capsule: Option<Entity<CapsulePlayer>>,
    tiles: Vec<Entity<Tile>>,
    still: Option<PathBuf>,
    files: Vec<PathBuf>,
}

impl Spike {
    fn new(mode: &str, files: &[PathBuf], window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut spike = Self {
            mode: mode.into(),
            capsule: None,
            tiles: Vec::new(),
            still: None,
            files: files.to_vec(),
        };
        match mode {
            "single" => {
                let path = files[0].clone();
                let capsule = cx.new(|cx| CapsulePlayer::new(path, window, cx));
                capsule.update(cx, |capsule, _| {
                    if let Some(video) = capsule.video_mut() {
                        video.record_samples();
                    }
                });
                spike.capsule = Some(capsule);
            }
            "tiles" => {
                spike.tiles = files
                    .iter()
                    .take(4)
                    .enumerate()
                    .map(|(index, path)| cx.new(|_| Tile::new(path, index == 0, true)))
                    .collect();
            }
            "still" => {
                spike.still = Some(files[0].clone());
                spike.tiles = files[1..]
                    .iter()
                    .map(|path| cx.new(|_| Tile::new(path, false, false)))
                    .collect();
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
        if let Some(still) = &self.still {
            return root
                .flex()
                .flex_row()
                .child(
                    div().flex_1().min_w_0().h_full().child(
                        img(still.clone())
                            .size_full()
                            .object_fit(ObjectFit::Contain),
                    ),
                )
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
    video: Option<VideoPlayer>,
    error: Option<String>,
}

impl Tile {
    fn new(path: &Path, sound: bool, play: bool) -> Self {
        match VideoPlayer::open(path) {
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

    fn video(&mut self) -> &mut VideoPlayer {
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
            .children(
                self.video
                    .as_ref()
                    .and_then(VideoPlayer::surface)
                    .map(|s| s.size_full()),
            )
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
    read: impl FnOnce(&mut VideoPlayer) -> R,
) -> Option<R> {
    capsule.update(cx, |capsule, cx| {
        cx.notify();
        capsule.video_mut().map(read)
    })
}

fn press(cx: &mut AsyncApp, window: AnyWindowHandle, key: &'static str) {
    window
        .update(cx, |_, window, cx| {
            window.dispatch_keystroke(Keystroke::parse(key).expect("a key"), cx);
        })
        .expect("the window is open");
}

async fn run_single(cx: &mut AsyncApp, window: AnyWindowHandle, root: &Entity<Spike>) {
    let capsule = cx
        .update(|cx| root.read(cx).capsule.clone())
        .expect("a capsule");
    let file = cx.update(|cx| root.read(cx).files[0].clone());
    println!("file {}", file.display());
    let refresh = window
        .update(cx, |_, window, cx| window.refresh_interval(cx))
        .ok()
        .flatten();
    println!("display refresh {:?}", refresh);

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
    let (ready, first) = with_capsule(cx, &capsule, |video| {
        let samples = video.samples().expect("recording");
        (samples.ready_after(), samples.first_frame_after())
    })
    .unwrap_or_default();
    let error = cx.update(|cx| capsule.read(cx).error().map(ToString::to_string));
    if !opened || error.is_some() {
        println!("open failed: {error:?}");
        return;
    }
    println!("open: ready {} first picture {}", ms(ready), ms(first));

    if inactive() {
        cx.update(|cx| {
            let bounds = Bounds::centered(None, size(px(240.), px(160.)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |window, cx| {
                    window.activate_window();
                    cx.new(|_| Cover)
                },
            )
            .expect("open the cover window");
        });
        wait(cx, Duration::from_millis(500)).await;
        let active = window
            .update(cx, |_, window, _| window.is_window_active())
            .unwrap_or(true);
        println!("spike window active behind the cover: {active}");
    }

    wait(cx, WARM_UP).await;
    steady(cx, "single", std::slice::from_ref(&capsule), &[]).await;

    let seeks: [(&str, Step); 6] = [
        ("exact to 10 s, playing", Step::Seek(10., SeekMode::Exact)),
        ("fast to 3 s, playing", Step::Seek(3., SeekMode::Fast)),
        ("→ skip +5 s", Step::Key("right")),
        ("← skip −5 s", Step::Key("left")),
        ("exact to 15 s, paused (Space first)", Step::PausedSeek(15.)),
        (
            "exact to 1 s, scrub release",
            Step::Seek(1., SeekMode::Exact),
        ),
    ];
    for (label, step) in seeks {
        let before =
            with_capsule(cx, &capsule, |v| v.samples().map_or(0, |s| s.seeks().len())).unwrap_or(0);
        with_capsule(cx, &capsule, |video| {
            if let Some(samples) = video.samples_mut() {
                samples.clear_frames();
            }
        });
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
            with_capsule(cx, &capsule, |v| v.samples().map_or(0, |s| s.seeks().len())).unwrap_or(0)
                > before
        })
        .await;
        if !landed {
            println!("seek {label}: no picture in 5 s");
            continue;
        }
        if matches!(step, Step::PausedSeek(_)) {
            press(cx, window, "space");
        }
        // Sync is judged from the landing on: until then the window rightly holds the old
        // picture while AVPlayer's clock already reads the target.
        with_capsule(cx, &capsule, |video| {
            if let Some(samples) = video.samples_mut() {
                samples.clear_frames();
            }
        });
        wait(cx, AFTER_SEEK).await;
        let (seek, frames) = with_capsule(cx, &capsule, |video| {
            let samples = video.samples().expect("recording");
            (
                *samples.seeks().last().expect("a seek"),
                samples.frames().to_vec(),
            )
        })
        .expect("a video");
        let after = Pacing::of(&frames);
        println!(
            "seek {label}: {:?}{} target {:.3} s landed {:.3} s in {} (AVPlayer done in {}) | \
             then {} pictures, lead mean {:+.1} ms, |lead| p95 {:.1} ms max {:.1} ms",
            seek.mode(),
            if seek.keyframe() {
                " (to the keyframe before)"
            } else {
                ""
            },
            seek.target().as_secs_f64(),
            seek.landed().as_secs_f64(),
            ms(Some(seek.took())),
            ms(Some(seek.finished())),
            after.frames,
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

    // Warm opens: the same file again, with AVFoundation and VideoToolbox loaded.
    let mut warm = Vec::new();
    for _ in 0..3 {
        let mut video = cx
            .update(|_| VideoPlayer::open(&file))
            .expect("it opened before");
        video.record_samples();
        video.set_muted(true);
        let tile = cx.new(|_| Tile {
            video: Some(video),
            error: None,
        });
        cx.update(|cx| {
            root.update(cx, |root, cx| {
                root.capsule = None;
                root.tiles = vec![tile.clone()];
                cx.notify();
            })
        });
        wait_for(cx, Duration::from_secs(10), |cx| {
            tile.update(cx, |tile, _| {
                tile.video()
                    .samples()
                    .and_then(|s| s.first_frame_after())
                    .is_some()
            })
        })
        .await;
        warm.push(tile.update(cx, |tile, _| {
            tile.video().samples().and_then(|s| s.first_frame_after())
        }));
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
    let files = cx.update(|cx| root.read(cx).files.clone());
    for file in files.iter().take(4) {
        println!("tile {}", file.display());
    }
    wait_for(cx, Duration::from_secs(15), |cx| {
        tiles.iter().all(|tile| {
            tile.update(cx, |tile, _| {
                tile.video.as_ref().is_none_or(|video| {
                    video
                        .samples()
                        .and_then(|s| s.first_frame_after())
                        .is_some()
                        || matches!(video.status(), VideoStatus::Failed(_))
                })
            })
        })
    })
    .await;
    for (index, tile) in tiles.iter().enumerate() {
        let first = tile.update(cx, |tile, _| {
            tile.video
                .as_ref()
                .and_then(|v| v.samples().and_then(|s| s.first_frame_after()))
        });
        println!("tile {index}: open to first picture {}", ms(first));
    }
    wait(cx, WARM_UP).await;
    steady(cx, "tiles", &[], &tiles).await;

    // All four seek at once, as a Duplicates group stepping through its files would.
    let before: Vec<usize> = tiles
        .iter()
        .map(|tile| {
            tile.update(cx, |tile, cx| {
                cx.notify();
                let video = tile.video();
                video.seek(Duration::from_secs(10), SeekMode::Exact);
                video.samples().map_or(0, |s| s.seeks().len())
            })
        })
        .collect();
    wait_for(cx, Duration::from_secs(5), |cx| {
        tiles.iter().zip(&before).all(|(tile, before)| {
            tile.update(cx, |tile, _| {
                tile.video().samples().map_or(0, |s| s.seeks().len()) > *before
            })
        })
    })
    .await;
    for (index, tile) in tiles.iter().enumerate() {
        let seek = tile.update(cx, |tile, _| {
            tile.video()
                .samples()
                .and_then(|s| s.seeks().last().copied())
        });
        match seek {
            Some(seek) => println!(
                "tile {index}: exact to 10 s together landed {:.3} s in {}",
                seek.landed().as_secs_f64(),
                ms(Some(seek.took()))
            ),
            None => println!("tile {index}: the seek showed no picture"),
        }
    }
}

/// One file of a sweep: its folder, then its first picture, exact seek and fast seek.
type SweepRow = (String, Option<Duration>, Option<Duration>, Option<Duration>);

async fn run_sweep(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let files = cx.update(|cx| root.read(cx).files.clone());
    let mut rows: Vec<SweepRow> = Vec::new();
    for file in files {
        let folder = file
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tile = cx.new(|_| Tile::new(&file, false, true));
        cx.update(|cx| {
            root.update(cx, |root, cx| {
                root.tiles = vec![tile.clone()];
                cx.notify();
            })
        });
        let first = picture_after(cx, &tile, |samples| samples.first_frame_after()).await;
        let Some(first) = first else {
            let error = tile.update(cx, |tile, _| {
                tile.error.clone().or_else(|| {
                    tile.video
                        .as_ref()
                        .and_then(|v| v.error().map(ToString::to_string))
                })
            });
            println!("{}: no picture ({error:?})", file.display());
            rows.push((folder, None, None, None));
            continue;
        };
        wait(cx, Duration::from_millis(300)).await;
        let mut seeks = [None, None];
        for (slot, (share, mode)) in [(0.5, SeekMode::Exact), (0.25, SeekMode::Fast)]
            .into_iter()
            .enumerate()
        {
            let before = tile.update(cx, |tile, cx| {
                cx.notify();
                let video = tile.video();
                let target = video.duration().unwrap_or_default().mul_f64(share);
                video.seek(target, mode);
                video.samples().map_or(0, |s| s.seeks().len())
            });
            seeks[slot] = picture_after(cx, &tile, move |samples| {
                samples.seeks().get(before).map(|seek| seek.took())
            })
            .await;
            wait(cx, Duration::from_millis(200)).await;
        }
        let error = tile.update(cx, |tile, _| tile.video().error().map(ToString::to_string));
        let exact = tile.update(cx, |tile, _| {
            tile.video()
                .samples()
                .and_then(|s| s.seeks().first().copied())
        });
        println!(
            "{}: first picture {}, exact seek {}{}, fast seek {}{}",
            file.display(),
            ms(Some(first)),
            ms(seeks[0]),
            exact.map_or(String::new(), |seek| format!(
                " (target {:.3} s, landed {:.3} s{})",
                seek.target().as_secs_f64(),
                seek.landed().as_secs_f64(),
                if seek.keyframe() {
                    " on the keyframe before"
                } else {
                    ""
                }
            )),
            ms(seeks[1]),
            error
                .map(|error| format!(" (then: {error})"))
                .unwrap_or_default()
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

/// Waits up to 10 s for `read` to find a timing in the tile's samples.
async fn picture_after(
    cx: &mut AsyncApp,
    tile: &Entity<Tile>,
    read: impl Fn(&oriel_media::video::VideoSamples) -> Option<Duration>,
) -> Option<Duration> {
    let found = |cx: &mut AsyncApp| {
        tile.update(cx, |tile, _| {
            let video = tile.video.as_ref()?;
            if video.error().is_some() {
                return Some(None);
            }
            video.samples().and_then(&read).map(Some)
        })
    };
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if let Some(result) = found(cx) {
            return result;
        }
        wait(cx, Duration::from_millis(5)).await;
    }
    None
}

async fn run_errors(cx: &mut AsyncApp, root: &Entity<Spike>) {
    let files = cx.update(|cx| root.read(cx).files.clone());
    for file in files {
        let refused = VideoPlayer::open(&file)
            .err()
            .map(|error| error.to_string());
        let mut video = match VideoPlayer::open_any(&file) {
            Ok(video) => video,
            Err(error) => {
                println!("{}: open_any refused: {error}", file.display());
                continue;
            }
        };
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            video.poll(Duration::from_millis(16));
            if video.status() != &VideoStatus::Loading {
                break;
            }
            wait(cx, Duration::from_millis(10)).await;
        }
        println!(
            "{}: open says {:?}; AVFoundation says {:?} after {}",
            file.display(),
            refused,
            video.status(),
            ms(Some(start.elapsed()))
        );
    }
}

/// Measures a steady stretch of playing: the pictures each player showed, CPU and memory.
async fn steady(
    cx: &mut AsyncApp,
    label: &str,
    capsules: &[Entity<CapsulePlayer>],
    tiles: &[Entity<Tile>],
) {
    let clear = |cx: &mut AsyncApp| {
        for capsule in capsules {
            with_capsule(cx, capsule, |video| {
                if let Some(samples) = video.samples_mut() {
                    samples.clear_frames();
                }
            });
        }
        for tile in tiles {
            tile.update(cx, |tile, _| {
                if let Some(samples) = tile.video().samples_mut() {
                    samples.clear_frames();
                }
            });
        }
    };
    clear(cx);
    let start = Usage::now();
    wait(cx, STEADY).await;
    let end = Usage::now();

    let mut runs = Vec::new();
    for capsule in capsules {
        runs.push(
            with_capsule(cx, capsule, |video| {
                video.samples().map(|s| s.frames().to_vec())
            })
            .flatten()
            .unwrap_or_default(),
        );
    }
    for tile in tiles {
        runs.push(tile.update(cx, |tile, _| {
            tile.video()
                .samples()
                .map(|s| s.frames().to_vec())
                .unwrap_or_default()
        }));
    }
    for (index, frames) in runs.iter().enumerate() {
        let pacing = Pacing::of(frames);
        println!(
            "{label} #{index} steady {} s: {} pictures of {} expected at {:.2} fps, {} dropped; \
             interval p50 {:.1} ms p95 {:.1} ms max {:.1} ms; lead mean {:+.1} ms, \
             |lead| p95 {:.1} ms max {:.1} ms",
            STEADY.as_secs(),
            pacing.frames,
            pacing.expected,
            pacing.fps,
            pacing.dropped,
            pacing.interval_p50,
            pacing.interval_p95,
            pacing.interval_max,
            pacing.lead_mean,
            pacing.lead_p95,
            pacing.lead_max,
        );
    }
    let wall = end.at.duration_since(start.at).as_secs_f64();
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

/// What the pictures of a stretch say about pacing and sync.
struct Pacing {
    frames: usize,
    expected: usize,
    dropped: usize,
    fps: f64,
    interval_p50: f64,
    interval_p95: f64,
    interval_max: f64,
    lead_mean: f64,
    lead_p95: f64,
    lead_max: f64,
}

impl Pacing {
    fn of(frames: &[FrameSample]) -> Self {
        let mut steps: Vec<f64> = frames
            .windows(2)
            .map(|pair| pair[1].time().as_secs_f64() - pair[0].time().as_secs_f64())
            .filter(|step| *step > 0.)
            .collect();
        steps.sort_by(f64::total_cmp);
        let frame = steps.first().copied().unwrap_or(1. / 30.);
        let span = match (frames.first(), frames.last()) {
            (Some(first), Some(last)) => last.time().as_secs_f64() - first.time().as_secs_f64(),
            _ => 0.,
        };
        let dropped = steps
            .iter()
            .map(|step| ((step / frame).round() as usize).saturating_sub(1))
            .sum();
        let mut intervals: Vec<f64> = frames
            .windows(2)
            .map(|pair| pair[1].at().duration_since(pair[0].at()).as_secs_f64() * 1000.)
            .collect();
        intervals.sort_by(f64::total_cmp);
        let leads: Vec<f64> = frames.iter().map(|f| f.lead() * 1000.).collect();
        let mut magnitudes: Vec<f64> = leads.iter().map(|lead| lead.abs()).collect();
        magnitudes.sort_by(f64::total_cmp);
        Self {
            frames: frames.len(),
            expected: if frames.is_empty() {
                0
            } else {
                (span / frame).round() as usize + 1
            },
            dropped,
            fps: 1. / frame,
            interval_p50: percentile(&intervals, 0.5),
            interval_p95: percentile(&intervals, 0.95),
            interval_max: intervals.last().copied().unwrap_or(0.),
            lead_mean: leads.iter().sum::<f64>() / leads.len().max(1) as f64,
            lead_p95: percentile(&magnitudes, 0.95),
            lead_max: magnitudes.last().copied().unwrap_or(0.),
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
/// `ps`, as the scorecard's other memory figures are taken.
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
