//! The window's size, position and whether it was maximised, kept as Electron Oriel keeps them
//! (`apps/oriel/src/main/window-state.ts`): `window-state.json` in the shell's folder, holding
//! `{"bounds":{"x":…,"y":…,"width":…,"height":…},"maximized":false}` in whole points. A maximised
//! or full-screen window keeps the bounds it returns to.
//!
//! GPUI places a window on a display with bounds relative to that display, so the position is
//! the window's place on its display. With one display that is the same place Electron Oriel
//! keeps; with several, the window comes back at the same place on the main display.

use std::path::Path;

use gpui_kit::{Bounds, Pixels, WindowBounds, point, px, size};
use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "window-state.json";

/// Electron Oriel's first window: 1320 × 860.
pub const DEFAULT_SIZE: (f32, f32) = (1320., 860.);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    bounds: SavedBounds,
    maximized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SavedBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// Where the window opens: the saved bounds, or a size centred on the main display.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Placement {
    Bounds(Bounds<Pixels>),
    Centered(f32, f32),
}

impl WindowState {
    /// What to keep of the window's bounds as GPUI reports them.
    pub fn from_window_bounds(bounds: WindowBounds) -> Self {
        match bounds {
            WindowBounds::Windowed(bounds) => Self::new(bounds, false),
            WindowBounds::Maximized(bounds) => Self::new(bounds, true),
            // Electron Oriel does not keep full screen either; the window comes back at the
            // size it left full screen from.
            WindowBounds::Fullscreen(bounds) => Self::new(bounds, false),
        }
    }

    /// A window at `restore`, maximised over it or not.
    pub fn new(restore: Bounds<Pixels>, maximized: bool) -> Self {
        Self {
            bounds: SavedBounds {
                x: restore.origin.x.as_f32().round() as i32,
                y: restore.origin.y.as_f32().round() as i32,
                width: restore.size.width.as_f32().round() as i32,
                height: restore.size.height.as_f32().round() as i32,
            },
            maximized,
        }
    }

    pub fn is_maximized(&self) -> bool {
        self.maximized
    }

    pub fn bounds(&self) -> Bounds<Pixels> {
        let SavedBounds {
            x,
            y,
            width,
            height,
        } = self.bounds;
        Bounds::new(
            point(px(x as f32), px(y as f32)),
            size(px(width as f32), px(height as f32)),
        )
    }

    /// The window's last state, or `None` before the first one is saved or when the file is not
    /// one Electron Oriel would accept (whole numbers, a positive size).
    pub fn read(folder: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(folder.join(FILE_NAME)).ok()?;
        let state: Self = serde_json::from_str(&text).ok()?;
        (state.bounds.width > 0 && state.bounds.height > 0).then_some(state)
    }

    /// Saves the state for [`Self::read`] to find next start. A failure is logged, as Electron
    /// Oriel logs it: the window then opens where it did before.
    pub fn write(&self, folder: &Path) {
        let text = serde_json::to_string(self).expect("the window state serializes");
        if let Err(error) =
            oriel_ui::storage::write_atomically(&folder.join(FILE_NAME), text.as_bytes())
        {
            log::warn!("window state: {error}");
        }
    }

    /// Where to open: the saved bounds while they overlap `display` (the main display's visible
    /// area), else only their size, since the display that held them is gone.
    pub fn placement(state: Option<&Self>, display: Option<Bounds<Pixels>>) -> Placement {
        let Some(state) = state else {
            return Placement::Centered(DEFAULT_SIZE.0, DEFAULT_SIZE.1);
        };
        let bounds = state.bounds();
        match display {
            Some(display) if !overlaps(bounds, display) => {
                Placement::Centered(bounds.size.width.as_f32(), bounds.size.height.as_f32())
            }
            _ => Placement::Bounds(bounds),
        }
    }
}

fn overlaps(a: Bounds<Pixels>, b: Bounds<Pixels>) -> bool {
    a.left() < b.right() && a.right() > b.left() && a.top() < b.bottom() && a.bottom() > b.top()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(test: &str) -> std::path::PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-rs-window-state-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
    }

    #[test]
    fn writes_electron_oriels_file_and_reads_it_back() {
        let folder = scratch("round-trip");
        let state = WindowState::from_window_bounds(WindowBounds::Maximized(bounds(
            40., 25.4, 1400., 900.,
        )));
        state.write(&folder);

        let text = std::fs::read_to_string(folder.join(FILE_NAME)).unwrap();
        assert_eq!(
            text,
            r#"{"bounds":{"x":40,"y":25,"width":1400,"height":900},"maximized":true}"#
        );
        let read = WindowState::read(&folder).expect("the state just written");
        assert_eq!(read, state);
        assert!(read.is_maximized());
        assert_eq!(read.bounds(), bounds(40., 25., 1400., 900.));
    }

    #[test]
    fn refuses_what_electron_oriel_would_refuse() {
        let folder = scratch("refuses");
        assert_eq!(WindowState::read(&folder), None, "no file yet");
        for text in [
            r#"{"bounds":{"x":0,"y":0,"width":0,"height":900},"maximized":false}"#,
            r#"{"bounds":{"x":0.5,"y":0,"width":800,"height":900},"maximized":false}"#,
            r#"{"bounds":{"x":0,"y":0,"width":800,"height":900}}"#,
            "not json",
        ] {
            std::fs::write(folder.join(FILE_NAME), text).unwrap();
            assert_eq!(WindowState::read(&folder), None, "{text}");
        }
    }

    #[test]
    fn opens_where_it_was_unless_that_display_is_gone() {
        let display = bounds(0., 0., 1728., 1085.);
        assert_eq!(
            WindowState::placement(None, Some(display)),
            Placement::Centered(1320., 860.)
        );
        let on_screen =
            WindowState::from_window_bounds(WindowBounds::Windowed(bounds(100., 80., 1200., 800.)));
        assert_eq!(
            WindowState::placement(Some(&on_screen), Some(display)),
            Placement::Bounds(bounds(100., 80., 1200., 800.))
        );
        let off_screen = WindowState::from_window_bounds(WindowBounds::Windowed(bounds(
            3000., 80., 1200., 800.,
        )));
        assert_eq!(
            WindowState::placement(Some(&off_screen), Some(display)),
            Placement::Centered(1200., 800.)
        );
    }
}
