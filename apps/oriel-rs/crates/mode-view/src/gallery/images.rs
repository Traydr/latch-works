//! The gallery's decoded thumbnails: the most recently drawn few hundred, and no more.
//!
//! Without a cache of its own, `img()` keeps every image it has loaded in the App's asset cache
//! for good, so scrolling 20,000 tiles would end holding 20,000 decoded thumbnails. This keeps
//! the ones drawn last and releases the rest from memory and from the GPU's sprite atlas.

use std::collections::HashMap;
use std::sync::Arc;

use gpui_kit::{
    App, AppContext as _, Entity, ImageCache, ImageCacheError, ImageCacheItem, RenderImage,
    Resource, Window, hash,
};

/// A cache that never holds fewer than this, whatever the gallery asks.
const MIN_CAPACITY: usize = 64;

struct Held {
    item: ImageCacheItem,
    used: u64,
}

pub struct TileImages {
    capacity: usize,
    clock: u64,
    items: HashMap<u64, Held>,
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
                if let Some(Ok(image)) = held.item.get() {
                    cx.drop_image(image, None);
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

    /// Whether `resource` is decoded and ready to draw, without loading it.
    pub fn is_loaded(&self, resource: &Resource) -> bool {
        self.items
            .get(&hash(resource))
            .is_some_and(|held| matches!(held.item.get(), Some(Ok(_))))
    }

    /// Drops the least recently drawn until there is room for one more.
    fn make_room(&mut self, window: &mut Window, cx: &mut App) {
        while self.items.len() >= self.capacity {
            let Some((&oldest, _)) = self.items.iter().min_by_key(|(_, held)| held.used) else {
                break;
            };
            if let Some(held) = self.items.remove(&oldest)
                && let Some(Ok(image)) = held.item.get()
            {
                cx.drop_image(image, Some(window));
            }
        }
    }
}

impl ImageCache for TileImages {
    fn load(
        &mut self,
        resource: &Resource,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Result<Arc<RenderImage>, ImageCacheError>> {
        self.clock += 1;
        let key = hash(resource);
        if let Some(held) = self.items.get_mut(&key) {
            held.used = self.clock;
            return held.item.use_image(window);
        }
        self.make_room(window, cx);
        let item = ImageCacheItem::new(resource, cx);
        let image = item.use_image(window);
        self.items.insert(
            key,
            Held {
                item,
                used: self.clock,
            },
        );
        image
    }
}
