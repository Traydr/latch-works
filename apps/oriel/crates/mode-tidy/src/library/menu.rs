//! The Library's menu for a right-clicked file or the selection bar's "⋯" (`moreEntries`): what
//! applies to the files at hand, shown as a native menu, as Electron Oriel's `showMenu` shows
//! it. Each item sends [`LibraryMenu`] to the page with its choice.

use std::cell::RefCell;

use gpui_kit::component::native_menu::NativeMenu;
use oriel_core_tidy::contract::{
    EncoderCapabilities, FileId, FileRow, SelectionSummary, VideoCodecChoice,
};

use crate::format;
use crate::quick_look::QUICK_LOOK_LABEL;

/// What a menu item does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuChoice {
    QuickLook,
    Open,
    OpenInView,
    Reveal,
    Convert,
    Reencode(VideoCodecChoice),
    StripAudio,
    FixExtension,
    Rename,
    Prefer,
    ShowFolder,
    Move,
    Hold,
}

/// The action a Library menu item sends to the page.
#[derive(Clone, Debug, PartialEq, gpui_kit::Action)]
#[action(namespace = tidy_library, no_json)]
pub struct LibraryMenu(pub MenuChoice);

/// One line of the menu.
#[derive(Clone, Debug, PartialEq)]
pub enum MenuEntry {
    Item {
        label: String,
        choice: MenuChoice,
        enabled: bool,
    },
    Submenu {
        label: String,
        items: Vec<MenuEntry>,
    },
    Separator,
}

impl MenuEntry {
    fn item(label: impl Into<String>, choice: MenuChoice) -> Self {
        MenuEntry::Item {
            label: label.into(),
            choice,
            enabled: true,
        }
    }

    /// The entry's label, a submenu's items under it indented, for tests and logs.
    fn labels(&self, into: &mut Vec<String>, depth: usize) {
        match self {
            MenuEntry::Item { label, enabled, .. } => into.push(format!(
                "{}{label}{}",
                "  ".repeat(depth),
                if *enabled { "" } else { " (unavailable)" }
            )),
            MenuEntry::Submenu { label, items } => {
                into.push(format!("{}{label}", "  ".repeat(depth)));
                for item in items {
                    item.labels(into, depth + 1);
                }
            }
            MenuEntry::Separator => into.push(format!("{}—", "  ".repeat(depth))),
        }
    }
}

/// The codecs a video can be re-encoded as, with a note for one older devices cannot play.
const CODECS: [(VideoCodecChoice, &str, Option<&str>); 3] = [
    (VideoCodecChoice::Hevc, "HEVC", None),
    (
        VideoCodecChoice::Av1,
        "AV1",
        Some("Older devices can't play AV1"),
    ),
    (VideoCodecChoice::Avc, "H.264", None),
];

/// What applies to `files`: `target` is the one file the menu is about, if there is one, and
/// `held` what the files hold (`moreEntries`).
pub fn menu_entries(
    files: &[FileId],
    target: Option<&FileRow>,
    held: Option<&SelectionSummary>,
    capabilities: Option<&EncoderCapabilities>,
) -> Vec<MenuEntry> {
    let mut entries = Vec::new();
    if target.is_some() {
        // Off macOS, Quick Look opens the file in its default app (`QUICK_LOOK_LABEL`), which
        // is what Open does, so Open alone stands for both, with Space.
        if cfg!(target_os = "macos") {
            entries.extend([
                MenuEntry::item(format!("{QUICK_LOOK_LABEL}  Space"), MenuChoice::QuickLook),
                MenuEntry::item("Open", MenuChoice::Open),
            ]);
        } else {
            entries.push(MenuEntry::item("Open  Space", MenuChoice::Open));
        }
        entries.extend([
            MenuEntry::item("Open in View", MenuChoice::OpenInView),
            MenuEntry::item("Show in Finder  ⇧⌘R", MenuChoice::Reveal),
            MenuEntry::Separator,
        ]);
    }
    if let Some(held) = held {
        if held.convertible.files > 0 {
            entries.push(MenuEntry::item(
                format!(
                    "Convert {} to AVIF or MP4",
                    format::count(held.convertible.files)
                ),
                MenuChoice::Convert,
            ));
        }
        if held.videos > 0 {
            let items = CODECS
                .iter()
                .map(|(codec, label, note)| {
                    // AV1 runs on ffmpeg's SVT-AV1.
                    let enabled = capabilities.is_some_and(|capabilities| match codec {
                        VideoCodecChoice::Avc => capabilities.video.avc,
                        VideoCodecChoice::Hevc => capabilities.video.hevc,
                        VideoCodecChoice::Av1 => capabilities.video.av1 || capabilities.svt_av1,
                    });
                    MenuEntry::Item {
                        label: match note {
                            Some(note) => format!("{label} · {note}"),
                            None => (*label).to_string(),
                        },
                        choice: MenuChoice::Reencode(*codec),
                        enabled,
                    }
                })
                .collect();
            entries.push(MenuEntry::Submenu {
                label: format!("Re-encode {} as", format::plural(held.videos, "video")),
                items,
            });
        }
        if held.with_audio > 0 {
            entries.push(MenuEntry::item(
                format!(
                    "Remove the audio track from {}",
                    format::plural(held.with_audio, "video")
                ),
                MenuChoice::StripAudio,
            ));
        }
        if held.extension_mismatches > 0 {
            entries.push(MenuEntry::item(
                format!(
                    "Fix {}",
                    format::plural(held.extension_mismatches, "extension")
                ),
                MenuChoice::FixExtension,
            ));
        }
    }
    if let Some(target) = target
        && files.len() <= 1
    {
        let folder = if target.dir.is_empty() {
            "the top folder"
        } else {
            target.dir.as_str()
        };
        entries.extend([
            MenuEntry::item("Rename  ↩", MenuChoice::Rename),
            MenuEntry::Separator,
            MenuEntry::item(
                format!("Prefer {folder} for duplicates"),
                MenuChoice::Prefer,
            ),
            MenuEntry::item(format!("Show only {folder}"), MenuChoice::ShowFolder),
        ]);
    }
    entries.extend([
        MenuEntry::Separator,
        MenuEntry::item("Move to…  ⇧⌘M", MenuChoice::Move),
        MenuEntry::item("Move to holding  ⌘⌫", MenuChoice::Hold),
    ]);
    entries
}

/// The entries as the system's menu, each item sending [`LibraryMenu`].
pub fn native_menu(entries: &[MenuEntry]) -> NativeMenu {
    entries
        .iter()
        .fold(NativeMenu::new(), |menu, entry| match entry {
            MenuEntry::Item {
                label,
                choice,
                enabled,
            } => menu.menu_with_disabled(label.clone(), !enabled, Box::new(LibraryMenu(*choice))),
            MenuEntry::Submenu { label, items } => menu.submenu(label.clone(), native_menu(items)),
            MenuEntry::Separator => menu.separator(),
        })
}

thread_local! {
    static LAST: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Notes the menu about to show, for [`last_menu`].
pub fn record(entries: &[MenuEntry]) {
    let mut labels = Vec::new();
    for entry in entries {
        entry.labels(&mut labels, 0);
    }
    LAST.with(|last| *last.borrow_mut() = labels);
}

/// The labels of the Library menu shown last on this thread, a submenu's items indented under
/// it, for tests: the native menu itself cannot be read back.
pub fn last_menu() -> Vec<String> {
    LAST.with(|last| last.borrow().clone())
}
