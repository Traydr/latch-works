//! Tidy's pages, in Electron Oriel's order (`lib/navigation.tsx`): Overview is home; Duplicates,
//! Convert and Clean up are the work, in the order it is best done, and Shrink is the optional AV1
//! re-encode after them; Library and History are the archive; Holding sits at the sidebar's foot.

use gpui_kit::assets::IconName;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TidyPage {
    Overview,
    Duplicates,
    Convert,
    CleanUp,
    Shrink,
    Library,
    History,
    Holding,
}

impl TidyPage {
    pub const ALL: [TidyPage; 8] = [
        TidyPage::Overview,
        TidyPage::Duplicates,
        TidyPage::Convert,
        TidyPage::CleanUp,
        TidyPage::Shrink,
        TidyPage::Library,
        TidyPage::History,
        TidyPage::Holding,
    ];

    pub fn label(self) -> &'static str {
        match self {
            TidyPage::Overview => "Overview",
            TidyPage::Duplicates => "Duplicates",
            TidyPage::Convert => "Convert",
            TidyPage::CleanUp => "Clean up",
            TidyPage::Shrink => "Shrink",
            TidyPage::Library => "Library",
            TidyPage::History => "History",
            TidyPage::Holding => "Holding",
        }
    }

    /// The page's name in Electron Oriel's `oriel.tidy.view`.
    pub fn key(self) -> &'static str {
        match self {
            TidyPage::Overview => "overview",
            TidyPage::Duplicates => "duplicates",
            TidyPage::Convert => "convert",
            TidyPage::CleanUp => "cleanup",
            TidyPage::Shrink => "shrink",
            TidyPage::Library => "library",
            TidyPage::History => "history",
            TidyPage::Holding => "holding",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|page| page.key() == key)
    }

    /// The View menu's shortcut; Shrink has none, as in Electron Oriel.
    pub fn shortcut(self) -> Option<&'static str> {
        match self {
            TidyPage::Overview => Some("⌥⌘1"),
            TidyPage::Duplicates => Some("⌥⌘2"),
            TidyPage::Convert => Some("⌥⌘3"),
            TidyPage::CleanUp => Some("⌥⌘4"),
            TidyPage::Library => Some("⌥⌘5"),
            TidyPage::History => Some("⌥⌘6"),
            TidyPage::Holding => Some("⌥⌘7"),
            TidyPage::Shrink => None,
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            TidyPage::Overview => IconName::LayoutGrid,
            TidyPage::Duplicates => IconName::Copy,
            TidyPage::Convert => IconName::Repeat2,
            TidyPage::CleanUp => IconName::Sparkles,
            TidyPage::Shrink => IconName::Shrink,
            TidyPage::Library => IconName::Library,
            TidyPage::History => IconName::RotateCcw,
            TidyPage::Holding => IconName::Archive,
        }
    }

    /// The sidebar item's element id: `tidy-Overview`, `tidy-Clean up`, …
    pub fn item_id(self) -> String {
        format!("tidy-{}", self.label())
    }
}
