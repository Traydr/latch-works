//! The gallery's decoded thumbnails: the most recently drawn few hundred, and no more.
//!
//! Without a cache of its own, `img()` keeps every image it has loaded in the App's asset cache
//! for good, so scrolling 20,000 tiles would end holding 20,000 decoded thumbnails. This keeps
//! the ones drawn last and releases the rest from memory and from the GPU's sprite atlas.
//!
//! It also keeps less of each: once a tile has been painted its pixels are let go, and the cache
//! holds a one-pixel stand-in (`ImageCache::mark_uploaded`), which the atlas answers for as long
//! as the tile stays cached (the cache is the only one that drops it from the atlas). The WebP
//! files are decoded through libwebp into the same pixels GPUI's own decoder makes
//! (`oriel_media::still::decode_webp`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use gpui_kit::{
    App, AppContext as _, Bounds, Context, Corners, DevicePixels, Entity, IntoElement, ObjectFit,
    Pixels, RenderImage, Size, Styled as _, Window, canvas,
};
use oriel_media::still;
use oriel_ui::image_cache::{self, ImageCache, Slot};

/// A cache that never holds fewer than this, whatever the gallery asks.
const MIN_CAPACITY: usize = 64;

/// A tile's decoded thumbnail, as the cache hands it to the tile.
#[derive(Clone)]
pub struct TilePicture {
    image: Arc<RenderImage>,
    /// The thumbnail's own size, which the stand-in does not have.
    size: Size<DevicePixels>,
    /// Whether the atlas has the pixels, so `image` is the stand-in.
    uploaded: bool,
}

pub struct TileImages {
    capacity: usize,
    /// Each thumbnail with its own size, which the stand-in does not have.
    cache: ImageCache<Arc<Path>, Size<DevicePixels>>,
    /// The thumbnails decoded ahead of the scroll and not drawn yet. They keep their pixels
    /// until painted, so the ones the scroll no longer heads for are let go at once.
    ahead: HashSet<Arc<Path>>,
}

impl TileImages {
    pub fn new(capacity: usize, cx: &mut App) -> Entity<Self> {
        let images = cx.new(|_| Self {
            capacity: capacity.max(MIN_CAPACITY),
            cache: ImageCache::default(),
            ahead: HashSet::new(),
        });
        // Release the GPU textures when the cache itself goes.
        cx.observe_release(&images, |images, cx| {
            image_cache::release(images.cache.clear(), None, cx);
        })
        .detach();
        images
    }

    /// How many decoded thumbnails to keep. It must exceed the tiles drawn in one frame, or a
    /// drawn thumbnail would be dropped and reloaded every frame; the gallery asks for its
    /// visible rows and overscan with room to spare.
    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity.max(MIN_CAPACITY);
    }

    /// The thumbnail at `path`, once decoded, starting its decode if it is not cached. The cache
    /// notifies when a decode finishes.
    pub fn picture(
        &mut self,
        path: &Arc<Path>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<TilePicture> {
        self.ahead.remove(path);
        match self.cache.touch(path) {
            Some(Slot::Ready(image)) => {
                let image = image.clone();
                Some(TilePicture {
                    image,
                    size: *self.cache.meta(path)?,
                    uploaded: self.cache.is_uploaded(path),
                })
            }
            Some(Slot::Waiting(_) | Slot::Failed) => None,
            None => {
                self.decode(path, window, cx);
                None
            }
        }
    }

    /// Decodes the thumbnails at `paths` ahead of their tiles being drawn, and drops those decoded
    /// ahead before that are neither among `paths` nor drawn since, so no more than the rows
    /// ahead of the scroll hold pixels the atlas does not have yet.
    pub fn prefetch(&mut self, paths: &[Arc<Path>], window: &mut Window, cx: &mut Context<Self>) {
        let wanted: HashSet<&Arc<Path>> = paths.iter().collect();
        let gone: Vec<Arc<Path>> = self
            .ahead
            .iter()
            .filter(|path| !wanted.contains(path))
            .cloned()
            .collect();
        for path in gone {
            self.ahead.remove(&path);
            // Never painted, so the atlas has nothing of it; a decode under way is cancelled.
            drop(self.cache.remove(&path));
        }
        for path in paths {
            if !self.cache.contains(path) {
                self.decode(path, window, cx);
                self.ahead.insert(path.clone());
            }
        }
    }

    /// Starts decoding the thumbnail at `path`, making room for it first.
    fn decode(&mut self, path: &Arc<Path>, window: &mut Window, cx: &mut Context<Self>) {
        // Drops the least recently drawn until there is room for one more.
        let capacity = self.capacity;
        let evicted = self.cache.evict(|held, _| held >= capacity, |_, _| false);
        self.ahead.retain(|path| self.cache.contains(path));
        image_cache::release(evicted, Some(window), cx);
        let task = cx.spawn({
            let path = path.clone();
            async move |this, cx| {
                let file = path.clone();
                let decoded = cx
                    .background_spawn(async move {
                        let still = still::decode_webp(&std::fs::read(&file)?)?;
                        let size = Size {
                            width: DevicePixels(i32::try_from(still.width())?),
                            height: DevicePixels(i32::try_from(still.height())?),
                        };
                        anyhow::Ok((still.into_render_image(), size))
                    })
                    .await;
                this.update(cx, |this, cx| {
                    let image = match decoded {
                        Ok((image, size)) => {
                            if let Some(kept) = this.cache.meta_mut(&path) {
                                *kept = size;
                            }
                            Some(image)
                        }
                        Err(error) => {
                            log::debug!("no tile for {}: {error:#}", path.display());
                            None
                        }
                    };
                    // A thumbnail let go of meanwhile was never painted.
                    drop(this.cache.finish(&path, image));
                    cx.notify();
                })
                .ok();
            }
        });
        drop(self.cache.wait(path.clone(), Some(task), Size::default()));
    }
}

/// A tile's picture, covering the tile as `img().object_fit(ObjectFit::Cover)` does, with its
/// corners rounded to `radius`, painted from the atlas once it is there.
pub fn tile_picture(
    images: &Entity<TileImages>,
    path: Arc<Path>,
    picture: TilePicture,
    radius: Pixels,
) -> impl IntoElement {
    let images = images.clone();
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, (), window, cx| {
            let fit = ObjectFit::Cover.get_bounds(bounds, picture.size);
            // `paint_image` uploads nothing for a tile with no area, so the pixels stay.
            let visible = bounds.intersect(&fit);
            let uploads = [
                visible.size.width,
                visible.size.height,
                fit.size.width,
                fit.size.height,
            ]
            .iter()
            .all(|side| *side > Pixels::ZERO);
            let painted = window.paint_image(
                bounds,
                fit,
                Corners::all(radius),
                picture.image.clone(),
                0,
                false,
            );
            if painted.is_ok() && uploads && !picture.uploaded {
                images.update(cx, |images, _| {
                    images.cache.mark_uploaded(&path, &picture.image);
                });
            }
        },
    )
    .size_full()
}
