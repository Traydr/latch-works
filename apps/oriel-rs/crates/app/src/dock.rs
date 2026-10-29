//! The Dock icon's progress bar while a push or a Tidy change runs, as Electron Oriel draws it
//! (`BrowserWindow.setProgressBar` on macOS): the app's icon, with a bar along its foot.
//!
//! The Dock draws a tile's custom view into its own image, which a standard progress indicator
//! does not take part in, so the bar is a small view that draws itself, as Electron's
//! `ElectronProgressBar` is. Off the main thread (the test harness) this does nothing.

/// Shows `progress`, `0.0..=1.0`, on the Dock icon, or the plain icon for `None`.
pub fn show_progress(progress: Option<f32>) {
    #[cfg(target_os = "macos")]
    mac::show_progress(progress);
    #[cfg(not(target_os = "macos"))]
    let _ = progress;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};

    use objc2::rc::Retained;
    use objc2::{DefinedClass as _, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSApplication, NSBezierPath, NSColor, NSImageView, NSRectFill, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    /// The bar's height on the tile, Electron's 15 points.
    const BAR_HEIGHT: f64 = 15.;

    define_class!(
        // SAFETY: `NSView` has no subclassing requirements; the view adds an ivar and overrides
        // `drawRect:`, and does not implement `Drop`.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "OrielRsDockProgressView"]
        #[ivars = Cell<f64>]
        struct DockProgressView;

        impl DockProgressView {
            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                draw(self.bounds(), self.ivars().get());
            }
        }
    );

    impl DockProgressView {
        fn new(frame: NSRect, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Cell::new(0.));
            // SAFETY: `initWithFrame:` is `NSView`'s designated initialiser.
            unsafe { msg_send![super(this), initWithFrame: frame] }
        }
    }

    /// A rounded track with a grey edge, filled in violet as far as the work has got.
    fn draw(bounds: NSRect, value: f64) {
        let inset = |rect: NSRect, by: f64| {
            NSRect::new(
                NSPoint::new(rect.origin.x + by, rect.origin.y + by),
                NSSize::new(
                    (rect.size.width - 2. * by).max(0.),
                    (rect.size.height - 2. * by).max(0.),
                ),
            )
        };
        let edge = inset(bounds, 1.);
        let radius = edge.size.height / 2.;
        let outline = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(edge, radius, radius);
        outline.setLineWidth(2.);
        NSColor::grayColor().set();
        outline.stroke();

        let inner = inset(edge, 2.);
        let radius = inner.size.height / 2.;
        let clip = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(inner, radius, radius);
        clip.addClip();
        let filled = NSRect::new(
            inner.origin,
            NSSize::new(
                (inner.size.width * value.clamp(0., 1.)).floor(),
                inner.size.height,
            ),
        );
        // Tailwind's violet-500, the house accent.
        NSColor::colorWithSRGBRed_green_blue_alpha(0.545, 0.361, 0.965, 1.).set();
        NSRectFill(filled);
    }

    thread_local! {
        static BAR: RefCell<Option<Retained<DockProgressView>>> = const { RefCell::new(None) };
    }

    pub(super) fn show_progress(progress: Option<f32>) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let tile = app.dockTile();
        BAR.with_borrow_mut(|bar| match progress {
            None => {
                if bar.take().is_some() {
                    tile.setContentView(None);
                }
            }
            Some(value) => {
                let bar = bar.get_or_insert_with(|| {
                    let size = tile.size();
                    let icon = NSImageView::initWithFrame(
                        NSImageView::alloc(mtm),
                        NSRect::new(NSPoint::new(0., 0.), size),
                    );
                    icon.setImage(app.applicationIconImage().as_deref());
                    let bar = DockProgressView::new(
                        NSRect::new(NSPoint::new(0., 0.), NSSize::new(size.width, BAR_HEIGHT)),
                        mtm,
                    );
                    icon.addSubview(&bar);
                    tile.setContentView(Some(&icon));
                    bar
                });
                bar.ivars().set(f64::from(value));
                bar.setNeedsDisplay(true);
            }
        });
        tile.display();
    }
}
