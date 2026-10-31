//! Path (a): mpv's software renderer (`MPV_RENDER_API_TYPE_SW`) draws each frame into memory,
//! and the pixels become a GPUI `RenderImage` for `img()`.
//!
//! It is the simple path and the slow one: mpv converts every frame to RGB on the CPU (with
//! zimg or swscale), and GPUI uploads it to a new sprite-atlas texture, so each frame is copied
//! twice. mpv decodes with VideoToolbox and copies each frame back to memory first
//! (`hwdec=videotoolbox-copy`), since this renderer reads only frames in memory.

use std::ffi::{CStr, c_int};
use std::sync::Arc;

use gpui_kit::RenderImage;

use super::client::Core;
use super::ffi;
use super::render::{Backend, Picture};

/// GPUI's `RenderImage` is BGRA with straight alpha. mpv's `bgr0` leaves the fourth byte
/// undefined; FFmpeg's `bgra`, which mpv also accepts here, writes it opaque.
const FORMAT: &CStr = c"bgra";
/// mpv asks for rows and pointers aligned to 64 bytes, or it copies the frame once more.
const ALIGN: usize = 64;

pub(super) struct Software;

impl Backend for Software {
    fn create(&mut self, core: &Core) -> Result<*mut ffi::RenderContext, String> {
        let mut params = [
            ffi::RenderParam::new(ffi::RENDER_PARAM_API_TYPE, ffi::RENDER_API_TYPE_SW.as_ptr()),
            ffi::RenderParam::END,
        ];
        let mut context = std::ptr::null_mut();
        // SAFETY: a live core and a terminated parameter list naming the software API.
        let status = unsafe {
            (core.api().render_context_create)(&raw mut context, core.handle(), params.as_mut_ptr())
        };
        if status < 0 || context.is_null() {
            return Err(format!(
                "mpv's software renderer would not start: {}",
                core.api().describe(status)
            ));
        }
        Ok(context)
    }

    fn draw(
        &mut self,
        core: &Core,
        context: *mut ffi::RenderContext,
        (width, height): (u32, u32),
        timing: &[ffi::RenderParam],
    ) -> Result<Picture, String> {
        let row = width as usize * 4;
        let stride = row.next_multiple_of(ALIGN);
        // Large allocations come page-aligned from the system allocator, so the start is too.
        let mut pixels = vec![0u8; stride * height as usize];
        let size: [c_int; 2] = [width as c_int, height as c_int];
        let mut params: Vec<ffi::RenderParam> = vec![
            ffi::RenderParam::new(ffi::RENDER_PARAM_SW_SIZE, size.as_ptr()),
            ffi::RenderParam::new(ffi::RENDER_PARAM_SW_FORMAT, FORMAT.as_ptr()),
            ffi::RenderParam::new(ffi::RENDER_PARAM_SW_STRIDE, &raw const stride),
            ffi::RenderParam::new(ffi::RENDER_PARAM_SW_POINTER, pixels.as_mut_ptr()),
        ];
        params.extend_from_slice(timing);
        params.push(ffi::RenderParam::END);
        // SAFETY: a live context on its render thread; the size, format, stride and a buffer
        // of `stride * height` bytes, all alive for the call.
        let status = unsafe { (core.api().render_context_render)(context, params.as_mut_ptr()) };
        if status < 0 {
            return Err(core.api().describe(status));
        }
        if stride != row {
            for y in 1..height as usize {
                pixels.copy_within(y * stride..y * stride + row, y * row);
            }
            pixels.truncate(row * height as usize);
        }
        let buffer = image::RgbaImage::from_raw(width, height, pixels)
            .ok_or("the frame's buffer is the wrong size")?;
        Ok(Picture::Image(Arc::new(RenderImage::new(
            smallvec::smallvec![image::Frame::new(buffer)],
        ))))
    }
}
