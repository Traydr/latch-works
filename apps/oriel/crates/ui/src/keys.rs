//! The command key, ⌘ on macOS and Ctrl elsewhere, keys as the owner reads them, and the
//! system's own words for its file manager.
//!
//! GPUI reads `cmd-` as the Windows key on Windows, where Windows keeps most of its combinations
//! for itself (⊞1 opens the first taskbar app, ⊞M minimises every window). GPUI's own
//! `secondary-` means ⌘ or Ctrl, but `KeyBinding::new` parses without knowing the system and
//! refuses it, so the bindings name the key through [`cmd_or_ctrl!`] instead.

use gpui_kit::{Keystroke, Modifiers};

/// `cmd-<keys>` on macOS and `ctrl-<keys>` elsewhere, as a `&'static str` for
/// `KeyBinding::new`: `cmd_or_ctrl!("alt-1")` is ⌥⌘1 on macOS and Ctrl+Alt+1 on Windows.
#[macro_export]
macro_rules! cmd_or_ctrl {
    ($keys:literal) => {
        if cfg!(target_os = "macos") {
            concat!("cmd-", $keys)
        } else {
            concat!("ctrl-", $keys)
        }
    };
}

/// Opens Settings at the section of the mode on screen.
pub const SETTINGS: &str = cmd_or_ctrl!(",");
/// The sidebar full or as the rail.
pub const SIDEBAR: &str = cmd_or_ctrl!("\\");

/// What a command that shows a file in the system's file manager is called there.
pub const REVEAL_LABEL: &str = if cfg!(target_os = "macos") {
    "Show in Finder"
} else {
    "Show in Explorer"
};

/// A GPUI keystroke as the owner reads it: `cmd-alt-1` is ⌥⌘1 on macOS and Ctrl+Alt+1 elsewhere,
/// where the command key is Ctrl ([`cmd_or_ctrl!`]). A key it has no name for is written as it is,
/// its first letter upper case: `1–9`, `Click`.
pub fn display(keystroke: &str) -> String {
    let mac = cfg!(target_os = "macos");
    let (modifiers, key) = match keystroke.strip_suffix("--") {
        Some(modifiers) => (modifiers, "-"),
        None => keystroke.rsplit_once('-').unwrap_or(("", keystroke)),
    };
    let held = |name: &str| modifiers.split('-').any(|modifier| modifier == name);
    let command = held("cmd");
    let parts = [
        (held("ctrl") || (command && !mac), "⌃", "Ctrl"),
        (held("alt"), "⌥", "Alt"),
        (held("shift"), "⇧", "Shift"),
        (command && mac, "⌘", ""),
    ];
    let key = key_name(key, mac);
    if mac {
        let mut text: String = parts
            .iter()
            .filter(|(held, ..)| *held)
            .map(|(_, glyph, _)| *glyph)
            .collect();
        text.push_str(&key);
        text
    } else {
        let mut words: Vec<&str> = parts
            .iter()
            .filter(|(held, ..)| *held)
            .map(|(.., word)| *word)
            .collect();
        words.push(&key);
        words.join("+")
    }
}

/// A tooltip or menu row with its keys: "Rescan  ⌘R".
pub fn labelled(label: &str, keystroke: &str) -> String {
    format!("{label}  {}", display(keystroke))
}

fn key_name(key: &str, mac: bool) -> String {
    let named = match key {
        "enter" if mac => "↩",
        "enter" => "Enter",
        "backspace" if mac => "⌫",
        "backspace" => "Backspace",
        "delete" if mac => "⌦",
        "delete" => "Delete",
        "escape" => "Esc",
        "space" => "Space",
        "tab" => "Tab",
        "left" => "←",
        "right" => "→",
        "up" => "↑",
        "down" => "↓",
        "pageup" => "PgUp",
        "pagedown" => "PgDn",
        "home" => "Home",
        "end" => "End",
        _ => {
            let mut chars = key.chars();
            return match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => String::new(),
            };
        }
    };
    named.to_owned()
}

/// Whether the command key is held, for a key or click handler: ⌘ on macOS, where Ctrl does not
/// stand in for it, and Ctrl elsewhere.
pub fn command_held(modifiers: &Modifiers) -> bool {
    if cfg!(target_os = "macos") {
        modifiers.platform
    } else {
        modifiers.control
    }
}

/// A press on one of the number row's keys 1 to 9, and whether ⇧ was held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DigitKey {
    pub digit: usize,
    pub shift: bool,
}

/// Which of the keys 1 to 9 a press came from, by where the key is and whatever it types.
///
/// GPUI's keystroke says what a key typed, not which key it was. On macOS ⇧2 reads as `@` with ⇧
/// cleared on a US keyboard and as `"` on a German one, and on a French one the key alone types
/// `é` and ⇧ makes the digit. So on macOS this reads the key's code from the system's event, which
/// names its position on every layout. A numeric keypad's keys go by the digit they type.
pub fn digit_key(keystroke: &Keystroke) -> Option<DigitKey> {
    let typed = keystroke
        .key
        .parse()
        .ok()
        .filter(|digit| (1..=9).contains(digit));
    #[cfg(target_os = "macos")]
    if let Some(key) = macos::current_key() {
        let digit = number_row_digit(key.code).or(typed)?;
        return Some(DigitKey {
            digit,
            shift: key.shift,
        });
    }
    // With no system event to read, as on Windows or in a test, the keystroke is all there is. GPUI
    // reports a US keyboard's ⇧2 as `@` with ⇧ cleared, as on macOS. A symbol is read as a US
    // keyboard's on every layout, so a layout that types one otherwise reads as that ⇧ digit, and a
    // layout whose ⇧ makes the digit reads as that digit alone.
    if let Some(digit) = typed {
        return Some(DigitKey {
            digit,
            shift: keystroke.modifiers.shift,
        });
    }
    let digit = ["!", "@", "#", "$", "%", "^", "&", "*", "("]
        .iter()
        .position(|symbol| *symbol == keystroke.key)?;
    Some(DigitKey {
        digit: digit + 1,
        shift: true,
    })
}

/// The digit of a macOS key code on the number row, the same code on every layout.
#[cfg(any(target_os = "macos", test))]
fn number_row_digit(code: u16) -> Option<usize> {
    let row = [18, 19, 20, 21, 23, 22, 26, 28, 25];
    Some(row.iter().position(|key| *key == code)? + 1)
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSEventType};

    pub(super) struct NativeKey {
        pub code: u16,
        pub shift: bool,
    }

    /// The key press the app is handling, if it is handling one from the system.
    pub(super) fn current_key() -> Option<NativeKey> {
        let main_thread = MainThreadMarker::new()?;
        let event = NSApplication::sharedApplication(main_thread).currentEvent()?;
        (event.r#type() == NSEventType::KeyDown).then(|| NativeKey {
            code: event.keyCode(),
            shift: event.modifierFlags().contains(NSEventModifierFlags::Shift),
        })
    }
}

/// Whether this Enter or Space belongs to the control Tab has put focus on, so the page's own use
/// of the key must leave it alone: the control presses on the key's way up, and the page acting on
/// its way down would do two things with one press, one of them not asked for. A table, which
/// `except` names, has the keys of its own that the page acts on.
pub fn control_has_key(
    event: &gpui_kit::KeyDownEvent,
    except: Option<&gpui_kit::FocusHandle>,
    window: &gpui_kit::Window,
    cx: &gpui_kit::App,
) -> bool {
    let keys = &event.keystroke;
    matches!(keys.key.as_str(), "enter" | "space")
        && !keys.modifiers.modified()
        && window
            .focused(cx)
            .is_some_and(|focused| focused.tab_stop && Some(&focused) != except)
}

#[cfg(test)]
mod tests {
    use gpui_kit::Keystroke;

    use super::*;

    #[test]
    fn the_number_row_goes_by_position() {
        let digits: Vec<_> = [18, 19, 20, 21, 23, 22, 26, 28, 25]
            .map(number_row_digit)
            .to_vec();
        assert_eq!(digits, (1..=9).map(Some).collect::<Vec<_>>());
        // 0, and the keypad's 1.
        assert_eq!(number_row_digit(29), None);
        assert_eq!(number_row_digit(83), None);
    }

    #[test]
    fn a_press_without_a_system_event_reads_as_typed() {
        let digit = |keys| digit_key(&Keystroke::parse(keys).unwrap());
        assert_eq!(
            digit("3"),
            Some(DigitKey {
                digit: 3,
                shift: false
            })
        );
        assert_eq!(digit("0"), None);
        assert_eq!(digit("a"), None);
        assert_eq!(
            digit("@"),
            Some(DigitKey {
                digit: 2,
                shift: true
            })
        );
    }
}
