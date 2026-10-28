//! The house style as a GPUI Kit theme: `themes/oriel.json` holds Oriel Light and Oriel Dark,
//! from the `lw-*` tokens in `apps/oriel/src/index.css`.

use gpui_kit::App;
use gpui_kit::component::{Theme, ThemeRegistry};

const THEMES: &str = include_str!("../themes/oriel.json");
const LIGHT: &str = "Oriel Light";
const DARK: &str = "Oriel Dark";

/// Registers Oriel's themes and follows the system's appearance. Call after `gpui_kit::init`.
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
    Theme::sync_system_appearance(None, cx);
}

#[cfg(test)]
mod tests {
    use gpui_kit::component::try_parse_color;

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
}
