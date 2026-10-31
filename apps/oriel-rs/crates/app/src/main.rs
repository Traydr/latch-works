// A release build on Windows is a GUI program, so starting it opens no console window; a debug
// build keeps the console for its log.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    // Velopack's Setup.exe and uninstaller start the app with a hook argument
    // (`--veloapp-install`, `--veloapp-uninstall`, …) and kill it if it has not exited within
    // 15 to 30 seconds, so the hooks are answered before anything else. Nothing checks for
    // updates (decision 19).
    #[cfg(windows)]
    velopack::VelopackApp::build().run();
    oriel_rs::run();
}
