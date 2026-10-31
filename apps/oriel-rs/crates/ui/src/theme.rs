//! The house style as a GPUI Kit theme: `themes/oriel.json` holds Oriel Light and Oriel Dark,
//! from Electron Oriel's `lw-*` CSS tokens. One theme for every mode: the system's
//! appearance unless the owner picks one in Settings › General, as Electron Oriel's
//! `ThemeProvider` does.
//!
//! The theme is shown without GPUI Kit's font probes. Each `Theme::change` asks whether
//! `.SystemUIFont` lands on another family and whether the default monospace family (Menlo) is
//! installed, and the first time it lists every font on the machine to answer, about 30 ms of
//! the main thread before the window opens. On macOS the answers are fixed: the system font
//! resolves to itself and Menlo ships with the system, so the probes change nothing there. So
//! [`prepare`] lets GPUI Kit start over placeholder families, which its probes leave alone,
//! [`init`] puts the real ones back, and every later change goes through [`show`], which does
//! what `Theme::change` does less the probes.

use std::rc::Rc;

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeSet};
use gpui_kit::{App, Window};

use crate::storage::LocalStorage;

const THEMES: &str = include_str!("../themes/oriel.json");
const LIGHT: &str = "Oriel Light";
const DARK: &str = "Oriel Dark";

/// The family the theme names while GPUI Kit starts (see [`prepare`]); never drawn.
#[cfg(target_os = "macos")]
const PLACEHOLDER_FAMILY: &str = "Oriel RS placeholder";

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
        let mode = match self {
            ThemeChoice::System => system_mode(window, cx),
            ThemeChoice::Light => ThemeMode::Light,
            ThemeChoice::Dark => ThemeMode::Dark,
        };
        show(mode, cx);
    }
}

/// Call before `gpui_kit::init`, which then starts its theme over placeholder font families
/// that its font probes leave alone; [`init`] puts the real families back. Elsewhere than
/// macOS the probes may name another family, so they run as GPUI Kit has them.
pub fn prepare(cx: &mut App) {
    #[cfg(target_os = "macos")]
    cx.set_global(Theme {
        font_family: PLACEHOLDER_FAMILY.into(),
        mono_font_family: PLACEHOLDER_FAMILY.into(),
        ..Theme::default()
    });
    #[cfg(not(target_os = "macos"))]
    let _ = cx;
}

/// Shows Oriel's themes in the stored choice. Call after `gpui_kit::init`, and after
/// [`LocalStorage::init`] for the choice to be the owner's.
pub fn init(cx: &mut App) {
    #[cfg(target_os = "macos")]
    finish_prepared(cx);
    let themes = serde_json::from_str::<ThemeSet>(THEMES)
        .expect("themes/oriel.json is a valid GPUI Kit theme set")
        .themes;
    let named = |name: &str| -> Rc<ThemeConfig> {
        let theme = themes.iter().find(|theme| theme.name == name);
        Rc::new(theme.cloned().expect("both themes are in the set"))
    };
    // Kept out of GPUI Kit's registry: a change there makes the kit change the theme again,
    // probes and all, and nothing here lists the registry's themes.
    let (light, dark) = (named(LIGHT), named(DARK));
    let theme = Theme::global_mut(cx);
    theme.light_theme = light;
    theme.dark_theme = dark;
    ThemeChoice::stored(cx).apply(None, cx);
}

/// What GPUI Kit's own start does after creating its theme, which [`prepare`] took the place
/// of: its default themes, then its default families, the ones the probes keep on macOS.
#[cfg(target_os = "macos")]
fn finish_prepared(cx: &mut App) {
    if Theme::global(cx).font_family != PLACEHOLDER_FAMILY {
        return;
    }
    let registry = gpui_kit::component::ThemeRegistry::global(cx);
    let light = registry.default_light_theme().clone();
    let dark = registry.default_dark_theme().clone();
    let defaults = Theme::default();
    let theme = Theme::global_mut(cx);
    theme.light_theme = light.clone();
    theme.dark_theme = dark;
    theme.apply_config(&light);
    theme.font_family = defaults.font_family;
    theme.mono_font_family = defaults.mono_font_family;
}

/// Shows `mode`'s theme as `Theme::change` does (its config applied, the Base layer synced,
/// every window refreshed), on macOS without the font probes (see the module's notes).
pub fn show(mode: ThemeMode, cx: &mut App) {
    if !cfg!(target_os = "macos") {
        Theme::change(mode, None, cx);
        return;
    }
    let theme = Theme::global_mut(cx);
    theme.mode = mode;
    let config = if mode.is_dark() {
        theme.dark_theme.clone()
    } else {
        theme.light_theme.clone()
    };
    theme.apply_config(&config);
    Theme::sync_base(cx);
    cx.refresh_windows();
}

/// The system's appearance, read from the window where there is one, as GPUI Kit reads it.
fn system_mode(window: Option<&mut Window>, cx: &App) -> ThemeMode {
    window
        .map(|window| window.appearance())
        .unwrap_or_else(|| cx.window_appearance())
        .into()
}

/// Follows a change of the system's appearance, while the owner's choice is System.
pub fn follow_system_appearance(window: &mut Window, cx: &mut App) {
    if ThemeChoice::stored(cx) == ThemeChoice::System {
        show(system_mode(Some(window), cx), cx);
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::TestAppContext;
    use gpui_kit::component::{Theme, ThemeMode, ThemeRegistry, try_parse_color};

    use super::ThemeChoice;

    /// The theme Oriel shows without the font probes is the one GPUI Kit's own start and
    /// `Theme::change` show, as the app showed it before: the kit's defaults under Oriel's
    /// themes, in each mode, with macOS's families. A GPUI Kit bump that changes what a change
    /// does fails here.
    #[gpui_kit::test]
    fn shows_the_theme_gpui_kits_own_change_shows(
        kit: &mut TestAppContext,
        oriel: &mut TestAppContext,
    ) {
        kit.update(|cx| {
            gpui_kit::init(cx);
            let registry = ThemeRegistry::global_mut(cx);
            registry.load_themes_from_str(super::THEMES).unwrap();
            let light = registry.themes().get(super::LIGHT).cloned().unwrap();
            let dark = registry.themes().get(super::DARK).cloned().unwrap();
            let theme = Theme::global_mut(cx);
            theme.light_theme = light;
            theme.dark_theme = dark;
        });
        oriel.update(|cx| {
            super::prepare(cx);
            gpui_kit::init(cx);
            super::init(cx);
        });
        for mode in [ThemeMode::Dark, ThemeMode::Light, ThemeMode::Dark] {
            kit.update(|cx| Theme::change(mode, None, cx));
            kit.run_until_parked();
            oriel.update(|cx| super::show(mode, cx));
            oriel.run_until_parked();
            // The headless text system has no fonts, so there the kit's probe swaps Menlo for
            // the system font, where every Mac has Menlo.
            let shown = |cx: &mut TestAppContext| {
                cx.update(|cx| {
                    let mut theme = Theme::global(cx).clone();
                    let mono = std::mem::take(&mut theme.mono_font_family);
                    (format!("{theme:?}"), mono)
                })
            };
            let ((ours, mono), (theirs, _)) = (shown(oriel), shown(kit));
            assert_eq!(ours, theirs, "{mode:?}");
            assert_eq!(mono.as_ref(), "Menlo");
        }
    }

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
