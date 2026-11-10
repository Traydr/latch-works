//! Decoded pictures a view keeps for GPUI to draw. GPUI keeps every image it was handed in its
//! sprite atlas until it is told to drop it (plan 063's Phase 0 findings), so what a cache lets
//! go must be released there too: the cache hands back each image it lets go of, and
//! [`release`] or [`release_after_frame`] drops it from the atlas.
//!
//! A picture's pixels are needed once, to upload them to the atlas the first time it is painted;
//! after that GPUI paints it from the atlas by the image's id alone. [`ImageCache::mark_uploaded`]
//! then keeps a one-pixel stand-in under the same id in its place.
//!
//! Which pictures go is the owner's policy: the least recently used past a count or a byte cap
//! ([`ImageCache::evict`], which may spare some), or all but those near what is on screen
//! ([`ImageCache::retain`]). Each picture may carry what the owner needs beside it (`M`).

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;

use gpui_kit::{App, RenderImage, Task, Window};

/// Where a picture is.
pub enum Slot {
    /// Waiting to be decoded; dropping the task, when there is one, cancels the decode.
    Waiting(Option<Task<()>>),
    Ready(Arc<RenderImage>),
    /// It could not be decoded.
    Failed,
}

struct Held<M> {
    slot: Slot,
    /// Whether the atlas has the ready picture's pixels, so the slot holds its stand-in.
    uploaded: bool,
    /// When it was last asked for, on the cache's own clock.
    used: u64,
    meta: M,
}

pub struct ImageCache<K, M = ()> {
    held: HashMap<K, Held<M>>,
    clock: u64,
    /// The bytes of the ready pictures' pixels.
    bytes: u64,
}

impl<K: Eq + Hash + Clone, M> Default for ImageCache<K, M> {
    fn default() -> Self {
        Self {
            held: HashMap::new(),
            clock: 0,
            bytes: 0,
        }
    }
}

impl<K: Eq + Hash + Clone, M> ImageCache<K, M> {
    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// The bytes of the ready pictures' pixels.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn contains(&self, key: &K) -> bool {
        self.held.contains_key(key)
    }

    /// Where `key`'s picture is, without counting it as used.
    pub fn slot(&self, key: &K) -> Option<&Slot> {
        self.held.get(key).map(|held| &held.slot)
    }

    /// Where `key`'s picture is, counting it as used now.
    pub fn touch(&mut self, key: &K) -> Option<&Slot> {
        self.clock += 1;
        let held = self.held.get_mut(key)?;
        held.used = self.clock;
        Some(&held.slot)
    }

    pub fn meta(&self, key: &K) -> Option<&M> {
        self.held.get(key).map(|held| &held.meta)
    }

    pub fn meta_mut(&mut self, key: &K) -> Option<&mut M> {
        self.held.get_mut(key).map(|held| &mut held.meta)
    }

    /// Every picture held, with its slot and what the owner keeps beside it, and when it was
    /// last used (larger is later).
    pub fn iter(&self) -> impl Iterator<Item = (&K, &Slot, &M, u64)> {
        self.held
            .iter()
            .map(|(key, held)| (key, &held.slot, &held.meta, held.used))
    }

    /// Holds `key` as waiting for its decode, used now. A picture it held before is handed back.
    pub fn wait(&mut self, key: K, task: Option<Task<()>>, meta: M) -> Option<Arc<RenderImage>> {
        self.clock += 1;
        let held = Held {
            slot: Slot::Waiting(task),
            uploaded: false,
            used: self.clock,
            meta,
        };
        let old = self.held.insert(key, held);
        old.and_then(|old| self.forget(old.slot))
    }

    /// Sets `key`, waiting, to its decoded picture, or to failed when there is none. A picture
    /// `key` no longer waits for (it went meanwhile, or is ready already) is handed back.
    pub fn finish(&mut self, key: &K, image: Option<Arc<RenderImage>>) -> Option<Arc<RenderImage>> {
        let Some(held) = self.held.get_mut(key) else {
            return image;
        };
        if !matches!(held.slot, Slot::Waiting(_)) {
            return image;
        }
        let slot = match image {
            Some(image) => {
                self.bytes += pixel_bytes(&image);
                Slot::Ready(image)
            }
            None => Slot::Failed,
        };
        // The decode finishing is the task's own; it is let go, not cancelled.
        if let Slot::Waiting(Some(task)) = std::mem::replace(&mut held.slot, slot) {
            task.detach();
        }
        None
    }

    /// Whether `key`'s ready picture has been painted, so the cache holds its stand-in.
    pub fn is_uploaded(&self, key: &K) -> bool {
        self.held.get(key).is_some_and(|held| held.uploaded)
    }

    /// `image`, `key`'s ready picture, was painted, so the atlas has its pixels: from now on the
    /// cache keeps a one-pixel stand-in under its id, in the same place and use. The picture
    /// replaced is not handed back, since the stand-in keeps its id in the atlas.
    pub fn mark_uploaded(&mut self, key: &K, image: &RenderImage) {
        let Some(held) = self.held.get_mut(key) else {
            return;
        };
        let Slot::Ready(ready) = &mut held.slot else {
            return;
        };
        if held.uploaded || ready.id != image.id {
            return;
        }
        let stand_in = stand_in(image);
        self.bytes = self.bytes - pixel_bytes(ready) + pixel_bytes(&stand_in);
        *ready = stand_in;
        held.uploaded = true;
    }

    /// Lets go of `key`, handing back its picture if it was ready.
    pub fn remove(&mut self, key: &K) -> Option<Arc<RenderImage>> {
        let held = self.held.remove(key)?;
        self.forget(held.slot)
    }

    /// Keeps only the pictures `keep` says to, handing back the ready ones that went.
    pub fn retain(&mut self, mut keep: impl FnMut(&K, &M) -> bool) -> Vec<Arc<RenderImage>> {
        let gone: Vec<K> = self
            .held
            .iter()
            .filter(|(key, held)| !keep(key, &held.meta))
            .map(|(key, _)| key.clone())
            .collect();
        gone.iter().filter_map(|key| self.remove(key)).collect()
    }

    /// Lets go of the least recently used pictures while `over` says the cache holds too many
    /// (by count and bytes), sparing those `spare` names, and hands back the ready ones that went.
    pub fn evict(
        &mut self,
        over: impl Fn(usize, u64) -> bool,
        spare: impl Fn(&K, &M) -> bool,
    ) -> Vec<Arc<RenderImage>> {
        let mut evicted = Vec::new();
        while over(self.held.len(), self.bytes) {
            let Some(oldest) = self
                .held
                .iter()
                .filter(|(key, held)| !spare(key, &held.meta))
                .min_by_key(|(_, held)| held.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            evicted.extend(self.remove(&oldest));
        }
        evicted
    }

    /// Lets go of everything, handing back the ready pictures.
    pub fn clear(&mut self) -> Vec<Arc<RenderImage>> {
        self.bytes = 0;
        self.held
            .drain()
            .filter_map(|(_, held)| match held.slot {
                Slot::Ready(image) => Some(image),
                Slot::Waiting(_) | Slot::Failed => None,
            })
            .collect()
    }

    fn forget(&mut self, slot: Slot) -> Option<Arc<RenderImage>> {
        match slot {
            Slot::Ready(image) => {
                self.bytes -= pixel_bytes(&image);
                Some(image)
            }
            Slot::Waiting(_) | Slot::Failed => None,
        }
    }
}

/// A one-pixel image under `image`'s id. GPUI paints an image from its sprite atlas by id, and
/// reads the pixels only to upload them the first time, so once they are uploaded this paints
/// the same picture without keeping them (until the atlas is told to drop the id).
fn stand_in(image: &RenderImage) -> Arc<RenderImage> {
    let pixel = image::Frame::new(image::RgbaImage::new(1, 1));
    let mut stand_in = RenderImage::new(vec![pixel]);
    stand_in.id = image.id;
    Arc::new(stand_in)
}

/// The bytes of a decoded picture's pixels.
pub fn pixel_bytes(image: &RenderImage) -> u64 {
    let size = image.size(0);
    u64::from(size.width.0.unsigned_abs()) * u64::from(size.height.0.unsigned_abs()) * 4
}

/// Drops `images` from GPUI's sprite atlas, `window`'s when given. Outside a draw only: while a
/// frame is drawn GPUI lends the window out, and the drop would miss its atlas.
pub fn release(
    images: impl IntoIterator<Item = Arc<RenderImage>>,
    mut window: Option<&mut Window>,
    cx: &mut App,
) {
    for image in images {
        cx.drop_image(image, window.as_deref_mut());
    }
}

/// Drops `images` from GPUI's sprite atlas once the frame being drawn is done, for pictures let
/// go of while asked for in a draw: the window is back then, and the atlas lets go.
pub fn release_after_frame(images: Vec<Arc<RenderImage>>, cx: &mut App) {
    if !images.is_empty() {
        cx.defer(move |cx| release(images, None, cx));
    }
}
