//! The house style as a GPUI Kit theme: `themes/oriel.json` holds Oriel Light and Oriel Dark,
//! from the `lw-*` tokens in `apps/oriel/src/index.css`. One theme for every mode: the system's
//! appearance unless the owner picks one in Settings › General, as Electron Oriel's
//! `ThemeProvider` does.

use gpui_kit::component::{Theme, ThemeMode, ThemeRegistry};
use gpui_kit::{App, Window};

use crate::storage::LocalStorage;

const THEMES: &str = include_str!("../themes/oriel.json");
const LIGHT: &str = "Oriel Light";
const DARK: &str = "Oriel Dark";

/// Where the choice is kept, Electron Oriel's `localStorage` key.
pub const THEME_KEY: &str = "oriel.theme";

/// The owner's theme: the system's appearance, or one of the two.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeChoice {
    pub const ALL: [ThemeChoice; 3] = [ThemeChoice::System, ThemeChoice::Light, ThemeChoice::Dark];

    pub fn label(self) -> &'static str {
        match self {
            ThemeChoice::System => "System",
            ThemeChoice::Light => "Light",
            ThemeChoice::Dark => "Dark",
        }
    }

    /// The stored value, as Electron Oriel stores it: `system`, `light`, `dark`.
    pub fn key(self) -> &'static str {
        match self {
            ThemeChoice::System => "system",
            ThemeChoice::Light => "light",
            ThemeChoice::Dark => "dark",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|choice| choice.key() == key)
    }

    /// The choice stored last, or System when none is (or it is not one of the three).
    pub fn stored(cx: &App) -> Self {
        LocalStorage::get(cx, THEME_KEY)
            .and_then(Self::from_key)
            .unwrap_or_default()
    }

    /// Stores the choice and applies it at once.
    pub fn choose(self, window: Option<&mut Window>, cx: &mut App) {
        LocalStorage::set(cx, THEME_KEY, self.key());
        self.apply(window, cx);
    }

    /// Shows this theme, reading the system's appearance for System.
    pub fn apply(self, window: Option<&mut Window>, cx: &mut App) {
        match self {
            ThemeChoice::System => Theme::sync_system_appearance(window, cx),
            ThemeChoice::Light => Theme::change(ThemeMode::Light, window, cx),
            ThemeChoice::Dark => Theme::change(ThemeMode::Dark, window, cx),
        }
    }
}

/// Registers Oriel's themes and shows the stored choice. Call after `gpui_kit::init`, and after
/// [`LocalStorage::init`] for the choice to be the owner's.
pub fn init(cx: &mut App) {
    let registry = ThemeRegistry::global_mut(cx);
    registry
        .load_themes_from_str(THEMES)
        .expect("themes/oriel.json is a valid GPUI Kit theme set");
    let light = registry
        .themes()
        .get(LIGHT)
        .cloned()
        .expect("Oriel Light is in the set");
    let dark = registry
        .themes()
        .get(DARK)
        .cloned()
        .expect("Oriel Dark is in the set");

    let theme = Theme::global_mut(cx);
    theme.light_theme = light;
    theme.dark_theme = dark;
    ThemeChoice::stored(cx).apply(None, cx);
}

/// Follows a change of the system's appearance, while the owner's choice is System.
pub fn follow_system_appearance(window: &mut Window, cx: &mut App) {
    if ThemeChoice::stored(cx) == ThemeChoice::System {
        Theme::sync_system_appearance(Some(window), cx);
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::component::try_parse_color;

    use super::ThemeChoice;

    /// GPUI Kit falls back to its own default for a color it cannot parse, without a word, so a
    /// misspelt or unknown name (it has no `zinc`) would quietly give the theme shadcn's colors.
    #[test]
    fn every_color_in_the_theme_file_parses() {
        let file: serde_json::Value = serde_json::from_str(super::THEMES).unwrap();
        let themes = file["themes"].as_array().unwrap();
        assert_eq!(themes.len(), 2);
        for theme in themes {
            for (key, value) in theme["colors"].as_object().unwrap() {
                let value = value.as_str().unwrap();
                assert!(
                    try_parse_color(value).is_ok(),
                    "{}: {key} = {value} does not parse",
                    theme["name"]
                );
            }
        }
    }

    #[test]
    fn choices_are_stored_as_electron_oriel_stores_them() {
        let keys: Vec<_> = ThemeChoice::ALL.iter().map(|choice| choice.key()).collect();
        assert_eq!(keys, ["system", "light", "dark"]);
        assert_eq!(ThemeChoice::from_key("sepia"), None);
    }
}
