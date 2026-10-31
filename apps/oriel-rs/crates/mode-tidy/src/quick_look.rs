//! Quick Look (`desktop.quickLook`): the system's preview panel over the window, as Finder's Space
//! shows it. Electron Oriel calls `BrowserWindow.previewFile`, which drives `QLPreviewPanel` with
//! its window as the panel's controller; Oriel RS does the same through the Objective-C runtime,
//! with a small responder after GPUI's window in its responder chain, since the panel looks for
//! its controller there.
//!
//! Where the panel cannot be driven (no Quick Look, or a platform without it), the file opens in
//! its default app instead. A window with no platform handle, as in a test, shows nothing; the
//! path asked for is kept for [`last_quick_look`] either way.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use gpui_kit::{App, Window};

thread_local! {
    static LAST: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Shows `path` in Quick Look over `window`, or opens it where Quick Look cannot show it.
pub fn quick_look(path: &Path, window: &Window, cx: &mut App) {
    LAST.with(|last| *last.borrow_mut() = Some(path.to_path_buf()));
    use raw_window_handle::HasWindowHandle;
    #[cfg(target_os = "macos")]
    use raw_window_handle::RawWindowHandle;
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let shown = match handle.as_raw() {
        #[cfg(target_os = "macos")]
        RawWindowHandle::AppKit(handle) => macos::preview(handle.ns_view.as_ptr(), path),
        _ => false,
    };
    if !shown {
        cx.open_with_system(path);
    }
}

/// The file Quick Look was last asked to show on this thread, for tests.
pub fn last_quick_look() -> Option<PathBuf> {
    LAST.with(|last| last.borrow().clone())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSString, NSURL};

    // QLPreviewPanel lives in QuickLookUI, inside Quartz; nothing else in the app links it.
    #[link(name = "Quartz", kind = "framework")]
    unsafe extern "C" {}

    thread_local! {
        /// The file the panel shows; its data source hands it out.
        static ITEM: RefCell<Option<Retained<NSURL>>> = const { RefCell::new(None) };
        /// The controller in the window's responder chain, which AppKit does not retain.
        static CONTROLLER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    /// An `NSResponder` that takes the panel's control and is its data source, as Electron's
    /// window and its delegate are.
    fn controller_class() -> &'static AnyClass {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let class = *CLASS.get_or_init(|| {
            let mut builder = ClassBuilder::new(c"OrielRsQuickLookController", class!(NSResponder))
                .expect("one Quick Look controller class");
            // SAFETY: each function's arguments and return type are those AppKit sends the
            // selector with (QLPreviewPanel.h).
            unsafe {
                builder.add_method(
                    sel!(acceptsPreviewPanelControl:),
                    accepts as extern "C" fn(_, Sel, *mut AnyObject) -> Bool,
                );
                builder.add_method(
                    sel!(beginPreviewPanelControl:),
                    begin as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(endPreviewPanelControl:),
                    end as extern "C" fn(_, Sel, *mut AnyObject),
                );
                builder.add_method(
                    sel!(numberOfPreviewItemsInPreviewPanel:),
                    count as extern "C" fn(_, Sel, *mut AnyObject) -> isize,
                );
                builder.add_method(
                    sel!(previewPanel:previewItemAtIndex:),
                    item as extern "C" fn(_, Sel, *mut AnyObject, isize) -> *mut AnyObject,
                );
            }
            builder.register() as *const AnyClass as usize
        });
        // SAFETY: a registered class lives as long as the process.
        unsafe { &*(class as *const AnyClass) }
    }

    extern "C" fn accepts(_: &AnyObject, _: Sel, _: *mut AnyObject) -> Bool {
        Bool::YES
    }

    extern "C" fn begin(this: &AnyObject, _: Sel, panel: *mut AnyObject) {
        // SAFETY: AppKit passes the shared panel, which takes any object as its data source.
        unsafe {
            let _: () = msg_send![panel, setDataSource: this];
            let _: () = msg_send![panel, reloadData];
        }
    }

    extern "C" fn end(_: &AnyObject, _: Sel, panel: *mut AnyObject) {
        // SAFETY: as in `begin`; nil clears the data source.
        unsafe {
            let _: () = msg_send![panel, setDataSource: std::ptr::null_mut::<AnyObject>()];
        }
    }

    extern "C" fn count(_: &AnyObject, _: Sel, _: *mut AnyObject) -> isize {
        ITEM.with(|item| isize::from(item.borrow().is_some()))
    }

    extern "C" fn item(_: &AnyObject, _: Sel, _: *mut AnyObject, _: isize) -> *mut AnyObject {
        // NSURL is a QLPreviewItem; the thread-local keeps it alive while the panel shows it.
        ITEM.with(|item| {
            item.borrow().as_ref().map_or(std::ptr::null_mut(), |url| {
                Retained::as_ptr(url) as *mut AnyObject
            })
        })
    }

    /// Shows `path` in the shared panel over the window holding `ns_view`; false when there is
    /// no panel to show it in.
    pub fn preview(ns_view: *mut c_void, path: &Path) -> bool {
        let Some(panel_class) = AnyClass::get(c"QLPreviewPanel") else {
            return false;
        };
        let Some(text) = path.to_str() else {
            return false;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        ITEM.with(|item| *item.borrow_mut() = Some(url));
        // SAFETY: GPUI hands out its window's content view, which lives while the window does;
        // the messages are NSView's, NSWindow's, NSResponder's and QLPreviewPanel's own.
        unsafe {
            let view = ns_view as *mut AnyObject;
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return false;
            }
            install(window);
            let panel: *mut AnyObject = msg_send![panel_class, sharedPreviewPanel];
            if panel.is_null() {
                return false;
            }
            let visible: bool = msg_send![panel, isVisible];
            if visible {
                let _: () = msg_send![panel, reloadData];
            } else {
                let _: () =
                    msg_send![panel, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
            }
        }
        true
    }

    /// Puts the controller right after `window` in its responder chain, once.
    ///
    /// # Safety
    ///
    /// `window` must be a live `NSWindow`.
    unsafe fn install(window: *mut AnyObject) {
        let class = controller_class();
        unsafe {
            let next: *mut AnyObject = msg_send![window, nextResponder];
            if !next.is_null() && (*next).class() == class {
                return;
            }
            let controller: Retained<AnyObject> = msg_send![class, new];
            let _: () = msg_send![&*controller, setNextResponder: next];
            let _: () = msg_send![window, setNextResponder: &*controller];
            CONTROLLER.with(|kept| *kept.borrow_mut() = Some(controller));
        }
    }
}
