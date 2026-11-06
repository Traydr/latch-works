//! `kill_running_tools` stops every run in the process, so it has a test binary of its own: in
//! a shared one it would kill the other tests' tools.

use std::time::{Duration, Instant};

use oriel_tools::{ToolRun, kill_running_tools};

/// A tool that lasts 30 seconds if nothing kills it.
fn long_tool() -> ToolRun {
    let timeout = Duration::from_secs(60);
    if cfg!(windows) {
        ToolRun::new("ping", timeout).args(["-n", "30", "127.0.0.1"])
    } else {
        ToolRun::new("/bin/sleep", timeout).arg("30")
    }
}

#[test]
fn quitting_kills_the_tools_still_running() {
    let started = Instant::now();
    let runs: Vec<_> = (0..2)
        .map(|_| std::thread::spawn(|| long_tool().run()))
        .collect();
    // Long enough for both to start; the kill reaches only tools already running.
    std::thread::sleep(Duration::from_millis(500));

    kill_running_tools();
    for run in runs {
        let error = run.join().unwrap().unwrap_err();
        assert!(error.is_cancelled(), "not a failure of the file: {error}");
    }
    assert!(started.elapsed() < Duration::from_secs(10));
    // Whatever the app was working through starts nothing more.
    assert!(long_tool().run().unwrap_err().is_cancelled());
    assert!(started.elapsed() < Duration::from_secs(10));
}
