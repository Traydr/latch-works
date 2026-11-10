//! The stills the viewer and the comic reader decode around the one in view, at the size they
//! show them, the one in view first: a step finds its neighbour ready, and the stills no longer
//! near are let go of, in memory and in GPUI's sprite atlas. Stills decode through ImageIO, as
//! GPUI's own decoder reads neither AVIF nor HEIC.

use std::path::Path;
use std::sync::Arc;

use gpui_kit::{App, Context, Priority, RenderImage, Window};
use oriel_ui::image_cache::{self, ImageCache, Slot};

#[derive(Default)]
pub(crate) struct NeighbourStills {
    cache: ImageCache<usize>,
    /// The longest side stills decode at, in device pixels.
    size: u32,
}

impl NeighbourStills {
    /// Still `ix`, once decoded.
    pub(crate) fn ready(&self, ix: usize) -> Option<&Arc<RenderImage>> {
        match self.cache.slot(&ix)? {
            Slot::Ready(image) => Some(image),
            Slot::Waiting(_) | Slot::Failed => None,
        }
    }

    /// Decodes the stills from now on no larger than `size` on their longer side.
    pub(crate) fn set_size(&mut self, size: u32) {
        self.size = size;
    }

    pub(crate) fn failed(&self, ix: usize) -> bool {
        matches!(self.cache.slot(&ix), Some(Slot::Failed))
    }

    /// Lets go of every still but those `wanted` names.
    pub(crate) fn keep(
        &mut self,
        wanted: impl Fn(usize) -> bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        let gone = self.cache.retain(|ix, _| wanted(*ix));
        image_cache::release(gone, Some(window), cx);
    }

    /// Decodes the still at `path` as still `ix` on the background executor at `priority`, unless
    /// it is held already. `done` runs on the host
    /// when it is decoded or failed to.
    pub(crate) fn decode<T: 'static>(
        &mut self,
        ix: usize,
        path: Arc<Path>,
        priority: Priority,
        cx: &mut Context<T>,
        stills: fn(&mut T) -> &mut Self,
        done: fn(&mut T, usize, &mut Context<T>),
    ) {
        if self.cache.contains(&ix) {
            return;
        }
        let size = self.size;
        let decoding = cx
            .background_executor()
            .spawn_with_priority(priority, async move {
                let decoded = oriel_media::still::decode(&path, size);
                if let Err(error) = &decoded {
                    log::warn!("cannot show {}: {error:#}", path.display());
                }
                decoded.ok().map(|still| still.into_render_image())
            });
        let task = cx.spawn(async move |this, cx| {
            let image = decoding.await;
            this.update(cx, |this, cx| {
                // A still let go of meanwhile was never drawn, so the atlas has none of it.
                drop(stills(this).cache.finish(&ix, image));
                done(this, ix, cx);
            })
            .ok();
        });
        drop(self.cache.wait(ix, Some(task), ()));
    }

    /// Lets go of every still, as the overlay goes.
    pub(crate) fn release_all(&mut self, cx: &mut App) {
        image_cache::release(self.cache.clear(), None, cx);
    }
}
