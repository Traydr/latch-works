//! Quits the system asks for itself: the Dock icon's Quit, logging out, restarting. macOS asks
//! the app delegate `applicationShouldTerminate:` first, which GPUI's delegate does not answer, so
//! the app would quit at once with a push or a Tidy change half done. This answers it as ⌘Q is
//! answered (`QuitGuard`): while work runs, the quit is cancelled and handed to the guard, which
//! hides the window and quits when the work ends, as Electron Oriel's `before-quit` does.
//!
//! The answer must come at once, from inside AppKit, where the app cannot be borrowed, so it reads
//! a flag the guard keeps current and sends the request on to GPUI through a channel.
//!
//! Windows asks each top-level window with `WM_QUERYENDSESSION` before logging off, restarting or
//! shutting down, and GPUI's windows say yes. While work runs, this says no instead, with the
//! reason Windows shows on its "apps are preventing shutdown" screen, and hands the quit to the
//! guard: the window hides, and the app quits once the work ends, which lets the shutdown go on.
//! If the owner chooses to shut down anyway, `WM_ENDSESSION` follows and GPUI quits at once, as
//! macOS does when the owner forces a logout.

use std::cell::Cell;
use std::rc::Rc;

use futures::channel::mpsc::UnboundedSender;

/// Answers the system's quit requests from `holds` (whether a quit must wait), sending each one
/// that must to `requests`. Call once, on the main thread, after the app has launched.
pub fn install(holds: Rc<Cell<bool>>, requests: UnboundedSender<()>) {
    #[cfg(target_os = "macos")]
    mac::install(holds, requests);
    #[cfg(windows)]
    windows::install(holds, requests);
    #[cfg(not(any(target_os = "macos", windows)))]
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

#[cfg(windows)]
mod windows {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    use futures::channel::mpsc::UnboundedSender;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, EnumThreadWindows, GWLP_WNDPROC, SetWindowLongPtrW, WM_ENDSESSION,
        WM_QUERYENDSESSION, WNDPROC,
    };
    use windows::core::{BOOL, w};

    /// What the window procedure reads: whether a quit must wait, where to send it, and whether
    /// this end of the session has been handed to the guard already, so a second window asked
    /// the same question does not send a second quit, which would quit at once.
    struct Gate {
        holds: Rc<Cell<bool>>,
        requests: UnboundedSender<()>,
        asked: Cell<bool>,
    }

    thread_local! {
        static GATE: RefCell<Option<Gate>> = const { RefCell::new(None) };
        /// Each subclassed window and the procedure it had, which every message goes on to.
        static PREVIOUS: RefCell<Vec<(isize, WNDPROC)>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn install(holds: Rc<Cell<bool>>, requests: UnboundedSender<()>) {
        GATE.with_borrow_mut(|gate| {
            *gate = Some(Gate {
                holds,
                requests,
                asked: Cell::new(false),
            });
        });
        // Every top-level window GPUI has made on this thread: its hidden platform window, which
        // answers the session's end for the app, and the app's own windows.
        // SAFETY: the callback only subclasses the windows it is handed, on their own thread.
        let _ = unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(subclass), LPARAM(0)) };
    }

    unsafe extern "system" fn subclass(window: HWND, _: LPARAM) -> BOOL {
        // SAFETY: a window of this thread; its old procedure is kept and called for every
        // message, so GPUI's handling is unchanged but for the two answered here.
        let procedure: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
            session_proc;
        let previous =
            unsafe { SetWindowLongPtrW(window, GWLP_WNDPROC, procedure as usize as isize) };
        if previous != 0 {
            // SAFETY: a window procedure's address, as `GWLP_WNDPROC` gives it.
            let previous = unsafe { std::mem::transmute::<isize, WNDPROC>(previous) };
            PREVIOUS.with_borrow_mut(|known| known.push((window.0 as isize, previous)));
        }
        BOOL(1)
    }

    /// Whether the session's end must wait for work, handing the quit to the guard the first
    /// time it is asked.
    fn blocks() -> bool {
        GATE.with_borrow(|gate| {
            let Some(gate) = gate else {
                return false;
            };
            if gate.asked.get() {
                return true;
            }
            let hand_over = gate.holds.get() && gate.requests.unbounded_send(()).is_ok();
            gate.asked.set(hand_over);
            hand_over
        })
    }

    fn session_went_on() {
        GATE.with_borrow(|gate| {
            if let Some(gate) = gate {
                gate.asked.set(false);
            }
        });
    }

    unsafe extern "system" fn session_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_QUERYENDSESSION if blocks() => {
                // SAFETY: a window of this thread, and a static string.
                let _ = unsafe {
                    ShutdownBlockReasonCreate(
                        window,
                        w!(
                            "Oriel is finishing a push or a Tidy change, and quits when it is done."
                        ),
                    )
                };
                return LRESULT(0);
            }
            // The session went on after all (`wparam` false), or is ending now: either way the
            // question is answered.
            WM_ENDSESSION => {
                session_went_on();
                if wparam.0 == 0 {
                    // SAFETY: a window of this thread.
                    let _ = unsafe { ShutdownBlockReasonDestroy(window) };
                }
            }
            _ => {}
        }
        let previous = PREVIOUS.with_borrow(|known| {
            known
                .iter()
                .find(|(handle, _)| *handle == window.0 as isize)
                .map(|(_, previous)| *previous)
        });
        // SAFETY: the window's own procedure from before, with the message as it came.
        unsafe { CallWindowProcW(previous.flatten(), window, message, wparam, lparam) }
    }
}
