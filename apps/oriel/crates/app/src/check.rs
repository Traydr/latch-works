//! Start-up states for checking the shell in a real window, where scripted input is not
//! allowed (plan 063's measurements run the same way):
//!
//! - `ORIEL_ACTIVITY=tidy=0.4,sync=working` reports work for modes at start, to see the
//!   switcher's ring and dot and the Dock's progress. While a mode reports progress, quitting
//!   waits for it, so ⌘Q twice quits.
//! - `ORIEL_SETTINGS=general` (or `view`, `tidy`, `sync`) opens Settings at that section.
//! - `ORIEL_ABOUT=1` opens the About dialog, to see the licences a bundle lists.
//! - `ORIEL_ACTIVITY_PANEL=1` opens the activity panel whenever work runs, to see it without
//!   a click.

use gpui_kit::{App, Entity};
use oriel_ui::{ModeActivity, ModeId, SettingsSection, ShellState};

pub const ACTIVITY_VARIABLE: &str = "ORIEL_ACTIVITY";
pub const SETTINGS_VARIABLE: &str = "ORIEL_SETTINGS";
pub const ABOUT_VARIABLE: &str = "ORIEL_ABOUT";
pub const ACTIVITY_PANEL_VARIABLE: &str = "ORIEL_ACTIVITY_PANEL";

/// Whether `ORIEL_ABOUT` asks for the About dialog at start.
pub fn about_from_environment() -> bool {
    std::env::var(ABOUT_VARIABLE).is_ok_and(|value| value == "1")
}

/// Whether `ORIEL_ACTIVITY_PANEL` asks for the activity panel open while work runs.
pub fn activity_panel_from_environment() -> bool {
    std::env::var(ACTIVITY_PANEL_VARIABLE).is_ok_and(|value| value == "1")
}

/// Applies whichever of the variables are set.
pub fn apply_from_environment(state: &Entity<ShellState>, cx: &mut App) {
    if let Ok(activity) = std::env::var(ACTIVITY_VARIABLE) {
        for (mode, activity) in parse_activity(&activity) {
            state.update(cx, |state, cx| state.set_activity(mode, Some(activity), cx));
        }
    }
    if let Some(section) = std::env::var(SETTINGS_VARIABLE)
        .ok()
        .and_then(|key| parse_section(&key))
    {
        state.update(cx, |state, cx| state.open_settings(section, cx));
    }
}

/// `tidy=0.4,sync=working` as each mode's work; anything it cannot read is left out.
fn parse_activity(text: &str) -> Vec<(ModeId, ModeActivity)> {
    text.split(',')
        .filter_map(|entry| {
            let (mode, value) = entry.trim().split_once('=')?;
            let mode = ModeId::from_key(mode.trim())?;
            let activity = match value.trim() {
                "working" => ModeActivity::Working,
                ratio => ModeActivity::Progress(ratio.parse().ok()?),
            };
            Some((mode, activity))
        })
        .collect()
}

fn parse_section(key: &str) -> Option<SettingsSection> {
    SettingsSection::ALL
        .into_iter()
        .find(|section| section.key() == key.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_modes_work() {
        assert_eq!(
            parse_activity("tidy=0.4, sync=working, view=lots, frame=1"),
            [
                (ModeId::Tidy, ModeActivity::Progress(0.4)),
                (ModeId::Sync, ModeActivity::Working)
            ]
        );
        assert_eq!(parse_section("general"), Some(SettingsSection::General));
        assert_eq!(parse_section("sandbox"), None);
    }
}
