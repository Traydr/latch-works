//! The gallery's decoded thumbnails: the most recently drawn few hundred, and no more.
//!
//! Without a cache of its own, `img()` keeps every image it has loaded in the App's asset cache
//! for good, so scrolling 20,000 tiles would end holding 20,000 decoded thumbnails. This keeps
//! the ones drawn last and releases the rest from memory and from the GPU's sprite atlas.
//!
//! It also keeps less of each. A tile's pixels are needed once, to upload them to the atlas the
//! first time the tile is painted; after that GPUI paints it from the atlas by the image's id
//! alone. So once a tile has been painted its pixels are let go, and the cache holds a one-pixel
//! stand-in under the same id, which the atlas answers for as long as the tile stays cached (the
//! cache is the only one that drops it from the atlas). The WebP files are decoded through
//! libwebp into the same pixels GPUI's own decoder makes (`oriel_media::still::decode_webp`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use gpui_kit::{
    App, AppContext as _, Bounds, Context, Corners, DevicePixels, Entity, IntoElement, ObjectFit,
    Pixels, RenderImage, Size, Styled as _, Task, Window, canvas,
};
use oriel_media::still;

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

enum State {
    Loading(Task<()>),
    Ready(TilePicture),
    Failed,
}

struct Held {
    state: State,
    used: u64,
}

pub struct TileImages {
    capacity: usize,
    clock: u64,
    items: HashMap<Arc<Path>, Held>,
}

impl TileImages {
    pub fn new(capacity: usize, cx: &mut App) -> Entity<Self> {
        let images = cx.new(|_| Self {
            capacity: capacity.max(MIN_CAPACITY),
            clock: 0,
            items: HashMap::new(),
        });
        // Release the GPU textures when the cache itself goes.
        cx.observe_release(&images, |images, cx| {
            for (_, held) in images.items.drain() {
                if let State::Ready(picture) = held.state {
                    cx.drop_image(picture.image, None);
                }
            }
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
        self.clock += 1;
        if let Some(held) = self.items.get_mut(path) {
            held.used = self.clock;
            return match &held.state {
                State::Ready(picture) => Some(picture.clone()),
                State::Loading(_) | State::Failed => None,
            };
        }
        self.make_room(window, cx);
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
                        anyhow::Ok((still, size))
                    })
                    .await;
                this.update(cx, |this, cx| {
                    let Some(held) = this.items.get_mut(&path) else {
                        return;
                    };
                    let state = match decoded {
                        Ok((still, size)) => State::Ready(TilePicture {
                            image: still.into_render_image(),
                            size,
                            uploaded: false,
                        }),
                        Err(error) => {
                            log::debug!("no tile for {}: {error:#}", path.display());
                            State::Failed
                        }
                    };
                    // This task is the one finishing; it is let go, not cancelled.
                    if let State::Loading(task) = std::mem::replace(&mut held.state, state) {
                        task.detach();
                    }
                    cx.notify();
                })
                .ok();
            }
        });
        self.items.insert(
            path.clone(),
            Held {
                state: State::Loading(task),
                used: self.clock,
            },
        );
        None
    }

    /// The tile was painted from `image`, so the atlas has its pixels: from now on the cache
    /// keeps the stand-in.
    fn uploaded(&mut self, path: &Path, image: &Arc<RenderImage>) {
        let Some(Held {
            state: State::Ready(picture),
            ..
        }) = self.items.get_mut(path)
        else {
            return;
        };
        if picture.uploaded || picture.image.id != image.id {
            return;
        }
        picture.image = still::stand_in(image);
        picture.uploaded = true;
    }

    /// Drops the least recently drawn until there is room for one more.
    fn make_room(&mut self, window: &mut Window, cx: &mut App) {
        while self.items.len() >= self.capacity {
            let Some(oldest) = self
                .items
                .iter()
                .min_by_key(|(_, held)| held.used)
                .map(|(path, _)| path.clone())
            else {
                break;
            };
            if let Some(Held {
                state: State::Ready(picture),
                ..
            }) = self.items.remove(&oldest)
            {
                cx.drop_image(picture.image, Some(window));
            }
        }
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
                images.update(cx, |images, _| images.uploaded(&path, &picture.image));
            }
        },
    )
    .size_full()
}
