use std::borrow::Cow;

use gpui_kit::assets::icon_assets;
use gpui_kit::{AssetSource, Result, SharedString};

// The Lucide icons Oriel uses beyond GPUI Kit's default component set.
icon_assets!(
    OrielIcons,
    [
        Archive,
        BookOpen,
        Copy,
        Eraser,
        Film,
        FolderOpen,
        Gauge,
        RotateCcw,
        Image,
        Images,
        LayoutGrid,
        Library,
        PanelLeft,
        Pause,
        Play,
        RefreshCw,
        Repeat2,
        Shrink,
        Shuffle,
        Sparkles,
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
