//! Tidy's pages, in the sidebar's order: Overview is home; Duplicates,
//! Convert and Clean up are the work, in the order it is best done, and Shrink is the optional AV1
//! re-encode after them; Library and History are the archive; Holding sits at the sidebar's foot.
//!
//! What each page is called, where the sidebar puts it and the keys that show it are here, and the
//! sidebar, the View menu, the key bindings and the shortcut sheet are made from them.

use gpui_kit::Action;
use gpui_kit::assets::IconName;

/// Shows a page: View › its name, and ⌥⌘1–7.
#[derive(Clone, Copy, Debug, PartialEq, Action)]
#[action(namespace = tidy, no_json)]
pub struct ShowPage(pub TidyPage);

/// Where the sidebar puts a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageGroup {
    Home,
    ToDo,
    Archive,
    /// At the sidebar's foot.
    Foot,
}

impl PageGroup {
    /// The heading over the group, where it has one.
    pub fn label(self) -> Option<&'static str> {
        match self {
            PageGroup::ToDo => Some("To do"),
            PageGroup::Archive => Some("Archive"),
            PageGroup::Home | PageGroup::Foot => None,
        }
    }
}

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

    /// The page's name in the stored `oriel.tidy.view`, kept from Electron Oriel so the page a
    /// user left comes back.
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

    /// The keys that show the page, which also put it in the View menu: ⌘1–3 switch the modes,
    /// so the pages take ⌥⌘1–7. Shrink, optional, has none.
    pub fn keys(self) -> Option<&'static str> {
        match self {
            TidyPage::Overview => Some(oriel_ui::cmd_or_ctrl!("alt-1")),
            TidyPage::Duplicates => Some(oriel_ui::cmd_or_ctrl!("alt-2")),
            TidyPage::Convert => Some(oriel_ui::cmd_or_ctrl!("alt-3")),
            TidyPage::CleanUp => Some(oriel_ui::cmd_or_ctrl!("alt-4")),
            TidyPage::Library => Some(oriel_ui::cmd_or_ctrl!("alt-5")),
            TidyPage::History => Some(oriel_ui::cmd_or_ctrl!("alt-6")),
            TidyPage::Holding => Some(oriel_ui::cmd_or_ctrl!("alt-7")),
            TidyPage::Shrink => None,
        }
    }

    pub fn group(self) -> PageGroup {
        match self {
            TidyPage::Overview => PageGroup::Home,
            TidyPage::Duplicates | TidyPage::Convert | TidyPage::CleanUp | TidyPage::Shrink => {
                PageGroup::ToDo
            }
            TidyPage::Library | TidyPage::History => PageGroup::Archive,
            TidyPage::Holding => PageGroup::Foot,
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
