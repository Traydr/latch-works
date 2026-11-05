//! The command key: ⌘ on macOS and Ctrl elsewhere, as Electron's `CmdOrCtrl` reads.
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
