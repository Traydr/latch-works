//! Tidy's pages, in the sidebar's order: Tidy is home, one plan for everything Tidy up does
//! (Convert, Clean up and AV1 together), with Duplicates beside it, as the owner decides those;
//! Library and History are the archive; Holding sits at the sidebar's foot.
//!
//! What each page is called, where the sidebar puts it and the keys that show it are here, and the
//! sidebar, the View menu, the key bindings and the shortcut sheet are made from them.

use gpui_kit::Action;
use gpui_kit::assets::IconName;

/// Shows a page: View › its name, and ⌥⌘1–5.
#[derive(Clone, Copy, Debug, PartialEq, Action)]
#[action(namespace = tidy, no_json)]
pub struct ShowPage(pub TidyPage);

/// Where the sidebar puts a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageGroup {
    Home,
    Archive,
    /// At the sidebar's foot.
    Foot,
}

impl PageGroup {
    /// The heading over the group, where it has one.
    pub fn label(self) -> Option<&'static str> {
        match self {
            PageGroup::Archive => Some("Archive"),
            PageGroup::Home | PageGroup::Foot => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TidyPage {
    /// The Tidy page: what Tidy up would do to the folder, and the button that does it.
    Overview,
    Duplicates,
    Library,
    History,
    Holding,
}

impl TidyPage {
    pub const ALL: [TidyPage; 5] = [
        TidyPage::Overview,
        TidyPage::Duplicates,
        TidyPage::Library,
        TidyPage::History,
        TidyPage::Holding,
    ];

    pub fn label(self) -> &'static str {
        match self {
            TidyPage::Overview => "Tidy",
            TidyPage::Duplicates => "Duplicates",
            TidyPage::Library => "Library",
            TidyPage::History => "History",
            TidyPage::Holding => "Holding",
        }
    }

    /// The page's name in the stored `oriel.tidy.view`, kept from Electron Oriel so the page a
    /// user left comes back.
    pub fn key(self) -> &'static str {
        match self {
            TidyPage::Overview => "overview",
            TidyPage::Duplicates => "duplicates",
            TidyPage::Library => "library",
            TidyPage::History => "history",
            TidyPage::Holding => "holding",
        }
    }

    /// The page stored under `key`. Convert, Clean up and Shrink, pages once, are the Tidy page's
    /// rows now, so a user who left one comes back to it.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "convert" | "cleanup" | "shrink" => Some(TidyPage::Overview),
            _ => Self::ALL.into_iter().find(|page| page.key() == key),
        }
    }

    /// The keys that show the page, which also put it in the View menu: ⌘1–3 switch the modes,
    /// so the pages take ⌥⌘1–5.
    pub fn keys(self) -> Option<&'static str> {
        Some(match self {
            TidyPage::Overview => oriel_ui::cmd_or_ctrl!("alt-1"),
            TidyPage::Duplicates => oriel_ui::cmd_or_ctrl!("alt-2"),
            TidyPage::Library => oriel_ui::cmd_or_ctrl!("alt-3"),
            TidyPage::History => oriel_ui::cmd_or_ctrl!("alt-4"),
            TidyPage::Holding => oriel_ui::cmd_or_ctrl!("alt-5"),
        })
    }

    pub fn group(self) -> PageGroup {
        match self {
            TidyPage::Overview | TidyPage::Duplicates => PageGroup::Home,
            TidyPage::Library | TidyPage::History => PageGroup::Archive,
            TidyPage::Holding => PageGroup::Foot,
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            TidyPage::Overview => IconName::WandSparkles,
            TidyPage::Duplicates => IconName::Copy,
            TidyPage::Library => IconName::Library,
            TidyPage::History => IconName::RotateCcw,
            TidyPage::Holding => IconName::Archive,
        }
    }

    /// The sidebar item's element id: `tidy-Tidy`, `tidy-Duplicates`, …
    pub fn item_id(self) -> String {
        format!("tidy-{}", self.label())
    }
}
