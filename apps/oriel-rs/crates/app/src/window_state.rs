//! The window's size, position and whether it was maximised, kept as Electron Oriel keeps them
//! (`apps/oriel/src/main/window-state.ts`): `window-state.json` in the shell's folder, holding
//! `{"bounds":{"x":…,"y":…,"width":…,"height":…},"maximized":false}` in whole points. A maximised
//! or full-screen window keeps the bounds it returns to.
//!
//! The bounds are in Electron's screen coordinates: points, from the top left of the main
//! display, across every display. GPUI places a window on one display with bounds relative to
//! it, so the shell adds the display's place among the others when it saves ([`Screen`]), and
//! [`WindowState::placement`] finds the display the bounds are on when the window opens, as
//! Electron Oriel's `screen.getDisplayMatching` does. A window saved on a display since
//! unplugged opens at its size on the main display.

use std::path::Path;

use gpui_kit::{App, Bounds, DisplayId, Pixels, Point, WindowBounds, point, px, size};
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

/// Where the window opens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Placement {
    /// At `bounds` on `display`, relative to that display's top left, as GPUI places a window.
    /// No display is named when none is known, as in the tests' platform.
    On {
        display: Option<DisplayId>,
        bounds: Bounds<Pixels>,
    },
    /// A size centred on the main display.
    Centered(f32, f32),
}

/// A display as Electron's `screen` sees it: its whole area and the part windows may use (less
/// the menu bar and the Dock), both from the top left of the main display.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub id: DisplayId,
    pub frame: Bounds<Pixels>,
    pub visible: Bounds<Pixels>,
}

impl Screen {
    /// The displays GPUI knows, each at its place among the others.
    pub fn all(cx: &App) -> Vec<Screen> {
        cx.displays()
            .into_iter()
            .map(|display| {
                let origin = display_origin(display.id());
                let frame = display.bounds();
                let visible = display.visible_bounds();
                Screen {
                    id: display.id(),
                    frame: Bounds::new(origin, frame.size),
                    visible: Bounds::new(origin + visible.origin, visible.size),
                }
            })
            .collect()
    }
}

/// Where a display's top left is among the displays, from the top left of the main display, in
/// points: CoreGraphics' global display coordinates, which Electron's `screen` uses. GPUI
/// reports only each display's size.
pub fn display_origin(display: DisplayId) -> Point<Pixels> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGDisplayBounds(display: u32) -> objc2_foundation::NSRect;
        }
        // SAFETY: `CGDisplayBounds` takes any display id, and returns an empty rectangle for one
        // that is not attached.
        let bounds = unsafe { CGDisplayBounds(u64::from(display) as u32) };
        point(px(bounds.origin.x as f32), px(bounds.origin.y as f32))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display;
        point(px(0.), px(0.))
    }
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

    /// Where to open (`restoredBounds`): on the display that holds most of the saved bounds,
    /// while they overlap the part of it windows may use, else only at their size, since the
    /// display that held them is gone. With no displays known, at the bounds as they are.
    pub fn placement(state: Option<&Self>, screens: &[Screen]) -> Placement {
        let Some(state) = state else {
            return Placement::Centered(DEFAULT_SIZE.0, DEFAULT_SIZE.1);
        };
        let bounds = state.bounds();
        if screens.is_empty() {
            return Placement::On {
                display: None,
                bounds,
            };
        }
        let matching = screens
            .iter()
            .map(|screen| (screen, overlap_area(bounds, screen.frame)))
            .filter(|(_, area)| *area > 0.)
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(screen, _)| screen);
        match matching {
            Some(screen) if overlap_area(bounds, screen.visible) > 0. => Placement::On {
                display: Some(screen.id),
                bounds: Bounds::new(
                    point(
                        bounds.origin.x - screen.frame.origin.x,
                        bounds.origin.y - screen.frame.origin.y,
                    ),
                    bounds.size,
                ),
            },
            _ => Placement::Centered(bounds.size.width.as_f32(), bounds.size.height.as_f32()),
        }
    }
}

/// How much of `a` lies inside `b`, in square points.
fn overlap_area(a: Bounds<Pixels>, b: Bounds<Pixels>) -> f32 {
    let width = (a.right().min(b.right()) - a.left().max(b.left())).as_f32();
    let height = (a.bottom().min(b.bottom()) - a.top().max(b.top())).as_f32();
    width.max(0.) * height.max(0.)
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

    /// The main display, a laptop's 1728 × 1117 with a 32-point menu bar, and one to its right
    /// that sits 200 points lower.
    fn two_screens() -> [Screen; 2] {
        [
            Screen {
                id: DisplayId::new(1),
                frame: bounds(0., 0., 1728., 1117.),
                visible: bounds(0., 32., 1728., 1085.),
            },
            Screen {
                id: DisplayId::new(2),
                frame: bounds(1728., 200., 2560., 1440.),
                visible: bounds(1728., 225., 2560., 1415.),
            },
        ]
    }

    fn saved(x: f32, y: f32, width: f32, height: f32) -> WindowState {
        WindowState::from_window_bounds(WindowBounds::Windowed(bounds(x, y, width, height)))
    }

    #[test]
    fn opens_where_it_was_unless_that_display_is_gone() {
        let main = &two_screens()[..1];
        assert_eq!(
            WindowState::placement(None, main),
            Placement::Centered(1320., 860.)
        );
        assert_eq!(
            WindowState::placement(Some(&saved(100., 80., 1200., 800.)), main),
            Placement::On {
                display: Some(DisplayId::new(1)),
                bounds: bounds(100., 80., 1200., 800.)
            }
        );
        // Saved on the display to the right, since unplugged: its size on the main display.
        assert_eq!(
            WindowState::placement(Some(&saved(3000., 380., 1200., 800.)), main),
            Placement::Centered(1200., 800.)
        );
    }

    #[test]
    fn opens_on_the_display_that_held_it() {
        let screens = two_screens();
        // On the second display, its place there is relative to that display's top left.
        assert_eq!(
            WindowState::placement(Some(&saved(2000., 380., 1200., 800.)), &screens),
            Placement::On {
                display: Some(DisplayId::new(2)),
                bounds: bounds(272., 180., 1200., 800.)
            }
        );
        // Across both, the one holding more of it wins.
        assert_eq!(
            WindowState::placement(Some(&saved(1600., 300., 1200., 800.)), &screens),
            Placement::On {
                display: Some(DisplayId::new(2)),
                bounds: bounds(-128., 100., 1200., 800.)
            }
        );
        // Below the second display's foot, on no display at all.
        assert_eq!(
            WindowState::placement(Some(&saved(2000., 1700., 1200., 800.)), &screens),
            Placement::Centered(1200., 800.)
        );
        // With no displays known (the tests' platform), where it was.
        assert_eq!(
            WindowState::placement(Some(&saved(40., 30., 1000., 700.)), &[]),
            Placement::On {
                display: None,
                bounds: bounds(40., 30., 1000., 700.)
            }
        );
    }
}
