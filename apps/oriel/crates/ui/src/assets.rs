use std::borrow::Cow;

use gpui_kit::assets::icon_assets;
use gpui_kit::{AssetSource, Result, SharedString};

// The Lucide icons Oriel uses beyond GPUI Kit's default component set.
icon_assets!(
    OrielIcons,
    [
        Archive,
        ArrowRightLeft,
        ArrowUpDown,
        BookOpen,
        Clock,
        Copy,
        Download,
        Equal,
        Eraser,
        FastForward,
        Film,
        FolderInput,
        FolderOpen,
        FolderUp,
        Folders,
        Gauge,
        House,
        Image,
        Images,
        LayoutGrid,
        Library,
        List,
        ListFilter,
        ListTree,
        Lock,
        Maximize2,
        Monitor,
        MousePointerClick,
        Pause,
        PencilLine,
        Play,
        RefreshCcw,
        RefreshCw,
        Repeat2,
        RotateCcw,
        Shrink,
        Shuffle,
        SlidersHorizontal,
        Sparkles,
        Volume1,
        Volume2,
        VolumeX,
        WandSparkles
    ]
);

/// GPUI Kit's component icons, with Oriel's own on top.
pub struct OrielAssets;

impl AssetSource for OrielAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = OrielIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(OrielIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    /// Every icon named in `folder`'s Rust files, recursively.
    fn icons_used(folder: &Path, names: &mut Vec<String>) {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                icons_used(&path, names);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                names.extend(text.split("IconName::").skip(1).map(|rest| {
                    rest.chars()
                        .take_while(char::is_ascii_alphanumeric)
                        .collect::<String>()
                }));
            }
        }
    }

    /// An icon GPUI Kit names but the app does not bundle draws as nothing at all, without a word:
    /// each Convert row in History showed a blank tile that way.
    #[test]
    fn every_icon_the_app_names_is_bundled() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut names = Vec::new();
        for member in ["ui", "app", "mode-view", "mode-tidy", "mode-sync"] {
            icons_used(&crates.join(member).join("src"), &mut names);
        }
        names.retain(|name| name.chars().next().is_some_and(char::is_uppercase));
        names.sort();
        names.dedup();
        assert!(names.len() > 40, "{names:?}");
        let missing: Vec<&String> = names
            .iter()
            .filter(|name| {
                // `IconName::ArrowRightLeft` is the file `icons/arrow-right-left.svg`.
                let mut file = String::new();
                for (at, letter) in name.char_indices() {
                    if (letter.is_ascii_uppercase() || letter.is_ascii_digit()) && at > 0 {
                        file.push('-');
                    }
                    file.push(letter.to_ascii_lowercase());
                }
                let path = format!("icons/{file}.svg");
                !matches!(OrielAssets.load(&path), Ok(Some(_)))
            })
            .collect();
        assert!(missing.is_empty(), "not bundled: {missing:?}");
    }
}
