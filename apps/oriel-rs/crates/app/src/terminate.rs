//! Quits the system asks for itself: the Dock icon's Quit, logging out, restarting. macOS asks
//! the app delegate `applicationShouldTerminate:` first, which GPUI's delegate does not answer, so
//! the app would quit at once with a push or a Tidy change half done. This answers it as ⌘Q is
//! answered (`QuitGuard`): while work runs, the quit is cancelled and handed to the guard, which
//! hides the window and quits when the work ends, as Electron Oriel's `before-quit` does.
//!
//! The answer must come at once, from inside AppKit, where the app cannot be borrowed, so it reads
//! a flag the guard keeps current and sends the request on to GPUI through a channel.

use std::cell::Cell;
use std::rc::Rc;

use futures::channel::mpsc::UnboundedSender;

/// Answers the system's quit requests from `holds` (whether a quit must wait), sending each one
/// that must to `requests`. Call once, on the main thread, after the app has launched.
pub fn install(holds: Rc<Cell<bool>>, requests: UnboundedSender<()>) {
    #[cfg(target_os = "macos")]
    mac::install(holds, requests);
    #[cfg(not(target_os = "macos"))]
    let _ = (holds, requests);
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::ffi::CString;
    use std::rc::Rc;

    use futures::channel::mpsc::UnboundedSender;
    use objc2::encode::{Encode, EncodeReturn as _};
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, MethodImplementation as _, Sel};
    use objc2::sel;

    /// `NSApplicationTerminateReply`.
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    /// What the delegate method reads: whether a quit must wait, and where to send it.
    struct Gate {
        holds: Rc<Cell<bool>>,
        requests: UnboundedSender<()>,
    }

    thread_local! {
        static GATE: RefCell<Option<Gate>> = const { RefCell::new(None) };
    }

    pub(super) fn install(holds: Rc<Cell<bool>>, requests: UnboundedSender<()>) {
        let Some(class) = AnyClass::get(c"GPUIApplicationDelegate") else {
            log::warn!("no GPUI app delegate; the system's quits will not wait for work");
            return;
        };
        let selector = sel!(applicationShouldTerminate:);
        GATE.with_borrow_mut(|gate| *gate = Some(Gate { holds, requests }));
        if class.instance_method(selector).is_some() {
            return;
        }
        let imp =
            should_terminate as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
        let types = CString::new(format!(
            "{}{}{}{}",
            usize::ENCODING_RETURN,
            <*mut AnyObject>::ENCODING,
            Sel::ENCODING,
            <*mut AnyObject>::ENCODING,
        ))
        .expect("an encoding has no NUL");
        // SAFETY: the class is GPUI's app delegate, which does not implement the method; the
        // implementation's signature matches `types` and the selector's one argument.
        unsafe {
            class_addMethod(
                (class as *const AnyClass).cast_mut(),
                selector,
                imp.__imp(),
                types.as_ptr(),
            );
        }
    }

    extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        let hold = GATE.with_borrow(|gate| {
            gate.as_ref()
                .is_some_and(|gate| gate.holds.get() && gate.requests.unbounded_send(()).is_ok())
        });
        if hold {
            TERMINATE_CANCEL
        } else {
            TERMINATE_NOW
        }
    }
}
