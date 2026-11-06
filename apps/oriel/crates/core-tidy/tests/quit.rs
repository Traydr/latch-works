//! A tool killed under a scan or an analysis says nothing about the file it was reading, so nothing
//! is recorded and a later scan reads the file again. Quitting stops every tool in the process and
//! refuses new ones, so this has a test binary of its own, and one test.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::passes::{Media, Quiet};
use oriel_tools::{ToolRun, kill_running_tools};
use rusqlite::Connection;

/// One library and its catalog, under a folder removed when the test ends.
struct Library {
    engine: TidyEngine,
    root_id: i64,
    catalog: PathBuf,
}

impl Library {
    fn open(folder: &Path, label: &str, media: Media) -> Self {
        let folder = folder.join(label);
        let archive = folder.join("archive");
        oriel_test_archive::build_archive(&archive);
        let data = DataRoot::at(folder.join("data")).unwrap();
        let catalog = data.tidy().join("catalog.sqlite");
        let engine = block_on(TidyEngine::open_with(data, catalog.clone(), media)).unwrap();
        let root_id = block_on(engine.add_root(&archive)).unwrap().id;
        Self {
            engine,
            root_id,
            catalog,
        }
    }

    /// A scan and an analysis, to their end or until the tools are stopped.
    fn work(&self) {
        let _ = self.engine.scan_blocking(self.root_id, &Quiet::new());
        let _ = self.engine.analyze_blocking(self.root_id, &Quiet::new());
    }

    /// How many videos `condition` holds for.
    fn videos(&self, condition: &str) -> i64 {
        Connection::open(&self.catalog)
            .unwrap()
            .query_row(
                &format!("SELECT COUNT(*) FROM files WHERE kind = 'video' AND ({condition})"),
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// `pass` recorded nothing for any video: `condition` holds for none.
    fn nothing_recorded(&self, pass: &str, condition: &str) {
        assert_eq!(self.videos(condition), 0, "{pass} recorded a verdict");
    }
}

fn script(folder: &Path, name: &str, body: &str) -> PathBuf {
    let path = folder.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn wait_for_files(files: &[&Path]) {
    let until = Instant::now() + Duration::from_secs(180);
    while !files.iter().all(|file| file.exists()) {
        assert!(Instant::now() < until, "the tools did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_killed_tool_leaves_no_verdict_on_the_file() {
    let media = Media::locate();
    let (Some(vips), Some(ffmpeg), Some(ffprobe)) = (&media.vips, &media.ffmpeg, &media.ffprobe)
    else {
        eprintln!("skipped: needs libvips and the pinned ffmpeg and ffprobe");
        return;
    };
    let folder = std::env::temp_dir().join(format!("oriel-tidy-quit-{}", std::process::id()));
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(folder).unwrap();
    let tools = folder.join("tools");
    fs::create_dir_all(&tools).unwrap();
    let with = |ffmpeg: &Path, ffprobe: &Path| Media {
        vips: Some(vips.clone()),
        ffmpeg: Some(ffmpeg.to_owned()),
        ffprobe: Some(ffprobe.to_owned()),
    };

    // Something outside the app kills the tool, as the system does short of memory. The pass goes
    // on to the next file, and the file waits for a later scan.
    let dies = script(&tools, "dies", "kill -KILL $$");
    let dies_listening = script(
        &tools,
        "dies-listening",
        &format!(
            "case \"$*\" in *volumedetect*) kill -KILL $$ ;; esac\nexec '{}' \"$@\"",
            ffmpeg.display()
        ),
    );
    let library = Library::open(&folder, "probe-killed", with(ffmpeg, &dies));
    library.work();
    library.nothing_recorded("the probe", "probe_error IS NOT NULL OR probe_version > 0");
    let library = Library::open(&folder, "frames-killed", with(&dies, ffprobe));
    library.work();
    assert!(library.videos("probe_version > 0") > 0, "the probe ran");
    library.nothing_recorded(
        "the fingerprint",
        "fingerprint_error IS NOT NULL OR fingerprint_version > 0",
    );
    let library = Library::open(&folder, "sound-killed", with(&dies_listening, ffprobe));
    library.work();
    assert!(library.videos("fingerprint IS NOT NULL") > 0, "prints ran");
    library.nothing_recorded("the loudness", "loudness_version > 0");

    // Quitting, with a tool hanging in each pass.
    let hangs = |name: &str| {
        let started = tools.join(format!("{name}.started"));
        let tool = script(
            &tools,
            name,
            &format!("touch '{}'\nexec sleep 60", started.display()),
        );
        (tool, started)
    };
    let (probing, probe_started) = hangs("hanging-ffprobe");
    let (framing, frames_started) = hangs("hanging-ffmpeg");
    let listening_started = tools.join("listening.started");
    let listening = script(
        &tools,
        "hanging-while-listening",
        &format!(
            "case \"$*\" in *volumedetect*) touch '{}'; exec sleep 60 ;; esac\nexec '{}' \"$@\"",
            listening_started.display(),
            ffmpeg.display()
        ),
    );
    let probes = Library::open(&folder, "probe-quit", with(ffmpeg, &probing));
    let frames = Library::open(&folder, "frames-quit", with(&framing, ffprobe));
    let sound = Library::open(&folder, "sound-quit", with(&listening, ffprobe));
    let started = std::thread::scope(|scope| {
        scope.spawn(|| probes.work());
        scope.spawn(|| frames.work());
        scope.spawn(|| sound.work());
        wait_for_files(&[&probe_started, &frames_started, &listening_started]);
        let started = Instant::now();
        kill_running_tools();
        started
    });
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "the passes went on starting tools after the quit: {:?}",
        started.elapsed()
    );
    probes.nothing_recorded("the probe", "probe_error IS NOT NULL OR probe_version > 0");
    frames.nothing_recorded(
        "the fingerprint",
        "fingerprint_error IS NOT NULL OR fingerprint_version > 0",
    );
    sound.nothing_recorded("the loudness", "loudness_version > 0");
    assert!(
        ToolRun::new("/bin/sleep", Duration::from_secs(30))
            .arg("30")
            .run()
            .is_err_and(|error| error.is_cancelled()),
        "a tool started after the quit"
    );

    fs::remove_dir_all(&folder).unwrap();
}
