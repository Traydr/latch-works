//! The runner on the real pinned ffmpeg and ffprobe, on a clip ffmpeg makes here: probe output,
//! raw frames as bytes, failures as exit statuses, and kills at the timeout and on cancel. The
//! output bounds run on the system's `cat` and `sh`, which can write more than any probe.
//!
//! The ffmpeg tests skip, saying so, when the pinned tools have not been fetched; run
//! `cargo run -p oriel-tools --bin fetch-media-tools` first.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use oriel_runtime::CancelToken;
use oriel_tools::{
    FETCH_COMMAND, LocateError, MAX_STDERR_BYTES, MAX_STDOUT_BYTES, MediaTools, ToolError, ToolRun,
};

const TIMEOUT: Duration = Duration::from_secs(30);

/// The pinned tools, or `None` with a message when they have not been fetched. Any other
/// failure to find them fails the test.
fn tools(test: &str) -> Option<MediaTools> {
    match MediaTools::locate() {
        Ok(tools) => Some(tools),
        Err(error @ LocateError::NotFetched { .. }) => {
            eprintln!("skipping {test}: {error}");
            None
        }
        Err(error) => panic!("{error}"),
    }
}

fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-tools-run-tests")
        .join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

/// A one-second 96 x 64 H.264 clip at 12 frames a second, from ffmpeg's test pattern.
fn make_clip(tools: &MediaTools, folder: &Path) -> PathBuf {
    let clip = folder.join("clip.mp4");
    let output = ToolRun::new(tools.ffmpeg(), TIMEOUT)
        .args(["-hide_banner", "-v", "error", "-f", "lavfi"])
        .args(["-i", "testsrc2=size=96x64:rate=12", "-t", "1"])
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-y"])
        .arg(&clip)
        .run()
        .unwrap();
    assert!(output.success(), "{}", output.stderr);
    clip
}

/// An ffmpeg that would run until killed: the test pattern, encoded to nowhere.
fn endless(tools: &MediaTools, timeout: Duration) -> ToolRun {
    ToolRun::new(tools.ffmpeg(), timeout)
        .args([
            "-hide_banner",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=rate=30",
        ])
        .args(["-f", "null", "-"])
}

#[test]
fn ffprobe_reads_a_clip_ffmpeg_made() {
    let Some(tools) = tools("ffprobe_reads_a_clip_ffmpeg_made") else {
        return;
    };
    let clip = make_clip(&tools, &scratch("probe"));
    let output = ToolRun::new(tools.ffprobe(), TIMEOUT)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(&clip)
        .run()
        .unwrap();
    assert_eq!(output.code(), Some(0), "{}", output.stderr);
    assert!(!output.timed_out);

    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let stream = &probe["streams"][0];
    assert_eq!(stream["codec_name"], "h264");
    assert_eq!(
        (stream["width"].as_u64(), stream["height"].as_u64()),
        (Some(96), Some(64))
    );
    assert_eq!(stream["nb_frames"], "12");
    let duration: f64 = probe["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((duration - 1.0).abs() < 0.05, "{duration}");
}

#[test]
fn ffmpeg_writes_a_raw_frame_to_stdout_as_bytes() {
    let Some(tools) = tools("ffmpeg_writes_a_raw_frame_to_stdout_as_bytes") else {
        return;
    };
    let clip = make_clip(&tools, &scratch("frame"));
    let output = ToolRun::new(tools.ffmpeg(), TIMEOUT)
        .args(["-hide_banner", "-v", "error", "-i"])
        .arg(&clip)
        .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        .run()
        .unwrap();
    assert!(output.success(), "{}", output.stderr);
    assert_eq!(output.stdout.len(), 96 * 64, "one 8-bit grey frame");
    assert!(
        output.stdout.iter().any(|&luma| luma != output.stdout[0]),
        "the test pattern is not one flat grey"
    );
}

#[test]
fn a_failing_run_returns_its_exit_status_and_stderr() {
    let Some(tools) = tools("a_failing_run_returns_its_exit_status_and_stderr") else {
        return;
    };
    let missing = scratch("failing").join("missing.mp4");
    let output = ToolRun::new(tools.ffprobe(), TIMEOUT)
        .args(["-v", "error"])
        .arg(&missing)
        .run()
        .expect("a non-zero exit is an output, not an error");
    assert!(!output.success());
    assert_eq!(output.code(), Some(1));
    assert!(
        output.stderr.contains("No such file or directory"),
        "{}",
        output.stderr
    );
}

#[test]
fn a_run_past_its_timeout_is_killed() {
    let Some(tools) = tools("a_run_past_its_timeout_is_killed") else {
        return;
    };
    let started = Instant::now();
    let output = endless(&tools, Duration::from_millis(500)).run().unwrap();
    assert!(output.timed_out);
    assert_eq!(output.code(), None, "killed, so no exit code");
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        assert_eq!(output.status.signal(), Some(9), "SIGKILL");
    }
    assert!(output.stderr.contains("testsrc2"), "{}", output.stderr);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn cancelling_kills_the_run() {
    let Some(tools) = tools("cancelling_kills_the_run") else {
        return;
    };
    let token = CancelToken::new();
    let cancelling = token.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        cancelling.cancel();
    });
    let started = Instant::now();
    let error = endless(&tools, TIMEOUT)
        .cancel_on(&token)
        .run()
        .unwrap_err();
    assert!(error.is_cancelled(), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10));
    canceller.join().unwrap();

    // A token cancelled before the run starts nothing.
    let error = ToolRun::new("/nonexistent/ffmpeg", TIMEOUT)
        .cancel_on(&token)
        .run()
        .unwrap_err();
    assert!(error.is_cancelled(), "{error}");
}

#[test]
fn a_missing_executable_fails_to_start() {
    let error = ToolRun::new("/nonexistent/ffmpeg", TIMEOUT)
        .run()
        .unwrap_err();
    assert!(matches!(error, ToolError::Start { .. }), "{error}");
    assert_eq!(error.to_string(), "starting /nonexistent/ffmpeg");
}

#[cfg(unix)]
#[test]
fn stdout_past_its_bound_is_cut_and_the_run_killed() {
    let output = ToolRun::new("/bin/cat", TIMEOUT)
        .arg("/dev/zero")
        .run()
        .unwrap();
    assert_eq!(output.stdout.len(), MAX_STDOUT_BYTES);
    assert_eq!(output.code(), None, "killed, so no exit code");
    assert!(!output.timed_out);
}

#[cfg(unix)]
#[test]
fn stderr_keeps_its_last_64_kib() {
    // About 100 KB of numbered lines on stderr.
    let script = concat!(
        "i=0; while [ $i -lt 2500 ]; do ",
        "echo \"line $i of the tool's chatter\" >&2; i=$((i+1)); done",
    );
    let output = ToolRun::new("/bin/sh", TIMEOUT)
        .args(["-c", script])
        .run()
        .unwrap();
    assert!(output.success());
    assert!(output.stderr.len() <= MAX_STDERR_BYTES);
    assert!(output.stderr.len() > MAX_STDERR_BYTES - 64);
    assert!(output.stderr.ends_with("line 2499 of the tool's chatter\n"));
    assert!(!output.stderr.contains("line 0 of"));
}

#[test]
fn the_skip_message_names_the_fetch_command() {
    let error = LocateError::NotFetched {
        folder: PathBuf::from(".media-tools/darwin-arm64"),
    };
    assert!(error.to_string().contains(FETCH_COMMAND));
}
