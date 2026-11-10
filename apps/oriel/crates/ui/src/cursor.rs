//! The pointer over a playing video or a page being read.

/// Hides the pointer until it next moves (`NSCursor.setHiddenUntilMouseMoves`): the viewer and
/// the comic reader do this as their controls fade. Does nothing off macOS, or where AppKit is
/// not loaded.
pub fn hide_pointer_until_it_moves() {
    #[cfg(target_os = "macos")]
    if let Some(cursor) = objc2::runtime::AnyClass::get(c"NSCursor") {
        // SAFETY: a class method of AppKit's NSCursor taking a BOOL, called on the main thread,
        // where views run.
        unsafe {
            let _: () =
                objc2::msg_send![cursor, setHiddenUntilMouseMoves: objc2::runtime::Bool::YES];
        }
    }
}
