//! `kill_running_tools` stops every run in the process, so it has a test binary of its own: in
//! a shared one it would kill the other tests' tools.

#![cfg(unix)]

use std::time::{Duration, Instant};

use oriel_tools::{ToolRun, kill_running_tools};

#[test]
fn quitting_kills_the_tools_still_running() {
    let started = Instant::now();
    let runs: Vec<_> = (0..2)
        .map(|_| {
            std::thread::spawn(|| {
                ToolRun::new("/bin/sleep", Duration::from_secs(60))
                    .arg("30")
                    .run()
            })
        })
        .collect();
    // Long enough for both to start; the kill reaches only tools already running.
    std::thread::sleep(Duration::from_millis(500));

    kill_running_tools();
    for run in runs {
        let output = run.join().unwrap().unwrap();
        assert_eq!(output.code(), None, "killed, so no exit code");
        assert!(!output.timed_out);
    }
    assert!(started.elapsed() < Duration::from_secs(10));
}
