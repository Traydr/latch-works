//! Path (b): mpv's OpenGL renderer on a CGL context of the render thread's own, drawing into a
//! framebuffer backed by an IOSurface, which VideoToolbox converts on the GPU into the `420f`
//! `CVPixelBuffer` GPUI's `surface()` draws. No pixel passes through the CPU.
//!
//! mpv decodes with VideoToolbox (`hwdec=videotoolbox`) and maps each decoded IOSurface into
//! GL as a texture, then converts it to RGB with the file's own matrix, range and primaries, and
//! scales it into the framebuffer. GPUI's surface shader turns Y'CbCr back into RGB with the
//! BT.601 full-range matrix whatever the buffer says, so the transfer session is asked for
//! exactly that: GPUI then undoes it, and the colours are mpv's to within rounding. The same
//! primaries and transfer function are stated on both sides so VideoToolbox converts the matrix
//! alone, with no colour matching.
//!
//! OpenGL is deprecated on macOS but still shipped; mpv's other GPU backends (Vulkan through
//! MoltenVK, its own macOS views) have no render API. The framework is opened at run time, as
//! libmpv is, so nothing links it unless this path runs.

use std::ffi::{CStr, c_char, c_int, c_void};
use std::ptr::{self, NonNull};
use std::sync::OnceLock;

use libloading::Library;
use objc2::runtime::AnyObject;
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_video::{
    CVAttachmentMode, CVPixelBuffer, CVPixelBufferCreate, kCVImageBufferColorPrimaries_ITU_R_709_2,
    kCVImageBufferColorPrimariesKey, kCVImageBufferTransferFunction_ITU_R_709_2,
    kCVImageBufferTransferFunctionKey, kCVImageBufferYCbCrMatrix_ITU_R_601_4,
    kCVImageBufferYCbCrMatrixKey, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferMetalCompatibilityKey, kCVPixelBufferOpenGLCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString};

use super::client::Core;
use super::ffi;
use super::render::{Backend, Picture, PixelBuffer};

const OPENGL: &str = "/System/Library/Frameworks/OpenGL.framework/OpenGL";

// CGLTypes.h.
const CGL_PFA_ACCELERATED: c_int = 73;
const CGL_PFA_ALLOW_OFFLINE_RENDERERS: c_int = 96;
const CGL_PFA_OPENGL_PROFILE: c_int = 99;
const CGL_OGLP_VERSION_GL4_CORE: c_int = 0x4100;

// gl3.h.
const GL_TEXTURE_RECTANGLE: u32 = 0x84F5;
const GL_RGBA: u32 = 0x1908;
const GL_RGBA8: c_int = 0x8058;
const GL_BGRA: u32 = 0x80E1;
const GL_UNSIGNED_INT_8_8_8_8_REV: u32 = 0x8367;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;

/// CGL and the few GL calls this file makes itself, from OpenGL.framework.
struct Gl {
    choose_pixel_format: unsafe extern "C" fn(
        attribs: *const c_int,
        pix: *mut *mut c_void,
        npix: *mut c_int,
    ) -> c_int,
    destroy_pixel_format: unsafe extern "C" fn(pix: *mut c_void) -> c_int,
    create_context:
        unsafe extern "C" fn(pix: *mut c_void, share: *mut c_void, ctx: *mut *mut c_void) -> c_int,
    destroy_context: unsafe extern "C" fn(ctx: *mut c_void) -> c_int,
    set_current_context: unsafe extern "C" fn(ctx: *mut c_void) -> c_int,
    tex_image_io_surface_2d: unsafe extern "C" fn(
        ctx: *mut c_void,
        target: u32,
        internal_format: u32,
        width: c_int,
        height: c_int,
        format: u32,
        kind: u32,
        surface: *mut c_void,
        plane: u32,
    ) -> c_int,
    gen_textures: unsafe extern "C" fn(n: c_int, textures: *mut u32),
    delete_textures: unsafe extern "C" fn(n: c_int, textures: *const u32),
    bind_texture: unsafe extern "C" fn(target: u32, texture: u32),
    gen_framebuffers: unsafe extern "C" fn(n: c_int, framebuffers: *mut u32),
    delete_framebuffers: unsafe extern "C" fn(n: c_int, framebuffers: *const u32),
    bind_framebuffer: unsafe extern "C" fn(target: u32, framebuffer: u32),
    framebuffer_texture_2d: unsafe extern "C" fn(
        target: u32,
        attachment: u32,
        textarget: u32,
        texture: u32,
        level: c_int,
    ),
    check_framebuffer_status: unsafe extern "C" fn(target: u32) -> u32,
    finish: unsafe extern "C" fn(),
    library: Library,
}

static GL: OnceLock<Result<Gl, String>> = OnceLock::new();

impl Gl {
    fn get() -> Result<&'static Gl, String> {
        GL.get_or_init(Gl::load).as_ref().map_err(Clone::clone)
    }

    fn load() -> Result<Gl, String> {
        // SAFETY: the system's OpenGL framework, whose initialisers have no preconditions.
        let library = unsafe { Library::new(OPENGL) }.map_err(|e| e.to_string())?;
        unsafe fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T, String> {
            let name = format!("{name}\0");
            // SAFETY: the caller's type is the function's C signature.
            unsafe { library.get::<T>(name.as_bytes()) }
                .map(|symbol| *symbol)
                .map_err(|error| error.to_string())
        }
        // SAFETY: each type is the C signature CGL's and GL's headers give the function named.
        unsafe {
            Ok(Gl {
                choose_pixel_format: symbol(&library, "CGLChoosePixelFormat")?,
                destroy_pixel_format: symbol(&library, "CGLDestroyPixelFormat")?,
                create_context: symbol(&library, "CGLCreateContext")?,
                destroy_context: symbol(&library, "CGLDestroyContext")?,
                set_current_context: symbol(&library, "CGLSetCurrentContext")?,
                tex_image_io_surface_2d: symbol(&library, "CGLTexImageIOSurface2D")?,
                gen_textures: symbol(&library, "glGenTextures")?,
                delete_textures: symbol(&library, "glDeleteTextures")?,
                bind_texture: symbol(&library, "glBindTexture")?,
                gen_framebuffers: symbol(&library, "glGenFramebuffers")?,
                delete_framebuffers: symbol(&library, "glDeleteFramebuffers")?,
                bind_framebuffer: symbol(&library, "glBindFramebuffer")?,
                framebuffer_texture_2d: symbol(&library, "glFramebufferTexture2D")?,
                check_framebuffer_status: symbol(&library, "glCheckFramebufferStatus")?,
                finish: symbol(&library, "glFinish")?,
                library,
            })
        }
    }
}

/// mpv's `get_proc_address`: every GL function by name, from the framework.
unsafe extern "C" fn get_proc_address(context: *mut c_void, name: *const c_char) -> *mut c_void {
    // SAFETY: the context is the `'static` `Gl` this file passes, and mpv passes a C string.
    let gl = unsafe { &*context.cast::<Gl>() };
    // SAFETY: as above.
    let name = unsafe { CStr::from_ptr(name) };
    // SAFETY: mpv casts the address to the function's own type.
    unsafe { gl.library.get::<*mut c_void>(name.to_bytes_with_nul()) }
        .map(|symbol| *symbol)
        .unwrap_or(ptr::null_mut())
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferGetIOSurface(buffer: *const CVPixelBuffer) -> *mut c_void;
    fn CVPixelBufferPoolCreate(
        allocator: *const c_void,
        pool_attributes: *const CFDictionary,
        buffer_attributes: *const CFDictionary,
        pool: *mut *mut c_void,
    ) -> i32;
    fn CVPixelBufferPoolCreatePixelBuffer(
        allocator: *const c_void,
        pool: *mut c_void,
        buffer: *mut *mut CVPixelBuffer,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    fn VTPixelTransferSessionCreate(allocator: *const c_void, session: *mut *mut c_void) -> i32;
    fn VTSessionSetProperty(session: *mut c_void, key: &CFString, value: &CFType) -> i32;
    fn VTPixelTransferSessionTransferImage(
        session: *mut c_void,
        source: &CVPixelBuffer,
        destination: &CVPixelBuffer,
    ) -> i32;
    fn VTPixelTransferSessionInvalidate(session: *mut c_void);
    static kVTPixelTransferPropertyKey_DestinationYCbCrMatrix: &'static CFString;
    static kVTPixelTransferPropertyKey_DestinationColorPrimaries: &'static CFString;
    static kVTPixelTransferPropertyKey_DestinationTransferFunction: &'static CFString;
}

/// The framebuffer mpv draws into, at one size: a BGRA IOSurface seen by GL as a rectangle
/// texture, and a pool of `420f` buffers of the same size for GPUI.
struct Target {
    size: (u32, u32),
    bgra: CFRetained<CVPixelBuffer>,
    texture: u32,
    framebuffer: u32,
    pool: *mut c_void,
}

/// The OpenGL path's state, all of it made and used on the render thread.
pub(super) struct OpenGl {
    gl: Option<&'static Gl>,
    cgl: *mut c_void,
    session: *mut c_void,
    target: Option<Target>,
}

// SAFETY: built empty on the UI thread and moved to the render thread before `create`; from
// then on only that thread touches the CGL context, GL objects and session.
unsafe impl Send for OpenGl {}

impl OpenGl {
    pub(super) fn new() -> Self {
        Self {
            gl: None,
            cgl: ptr::null_mut(),
            session: ptr::null_mut(),
            target: None,
        }
    }

    fn gl(&self) -> &'static Gl {
        self.gl.expect("create loaded GL")
    }

    /// Makes the BGRA framebuffer and the `420f` pool for `size`, dropping the old ones.
    fn ensure_target(&mut self, size: (u32, u32)) -> Result<(), String> {
        if self
            .target
            .as_ref()
            .is_some_and(|target| target.size == size)
        {
            return Ok(());
        }
        self.drop_target();
        let gl = self.gl();
        let bgra = pixel_buffer(size, kCVPixelFormatType_32BGRA)?;
        // SAFETY: an IOSurface-backed buffer, as asked for; the surface lives as long as it.
        let surface = unsafe { CVPixelBufferGetIOSurface(&*bgra) };
        if surface.is_null() {
            return Err("the framebuffer's pixel buffer has no IOSurface".into());
        }
        tag_colours(&bgra, false);
        let (mut texture, mut framebuffer) = (0u32, 0u32);
        // SAFETY: GL calls on the render thread with its context current; the surface covers
        // `size` in BGRA, a format/type pair CGL's IOSurface table lists.
        unsafe {
            (gl.gen_textures)(1, &raw mut texture);
            (gl.bind_texture)(GL_TEXTURE_RECTANGLE, texture);
            let status = (gl.tex_image_io_surface_2d)(
                self.cgl,
                GL_TEXTURE_RECTANGLE,
                GL_RGBA,
                size.0 as c_int,
                size.1 as c_int,
                GL_BGRA,
                GL_UNSIGNED_INT_8_8_8_8_REV,
                surface,
                0,
            );
            (gl.bind_texture)(GL_TEXTURE_RECTANGLE, 0);
            if status != 0 {
                (gl.delete_textures)(1, &raw const texture);
                return Err(format!("CGLTexImageIOSurface2D failed ({status})"));
            }
            (gl.gen_framebuffers)(1, &raw mut framebuffer);
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, framebuffer);
            (gl.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_RECTANGLE,
                texture,
                0,
            );
            let complete = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            if complete != GL_FRAMEBUFFER_COMPLETE {
                (gl.delete_framebuffers)(1, &raw const framebuffer);
                (gl.delete_textures)(1, &raw const texture);
                return Err(format!(
                    "the IOSurface framebuffer is incomplete ({complete:#x})"
                ));
            }
        }
        let attributes = buffer_attributes(size, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
        let mut pool = ptr::null_mut();
        // SAFETY: a valid attributes dictionary and an out pointer; the pool is released in
        // `drop_target`.
        let status = unsafe {
            CVPixelBufferPoolCreate(
                ptr::null(),
                ptr::null(),
                dictionary(&attributes),
                &raw mut pool,
            )
        };
        if status != 0 || pool.is_null() {
            return Err(format!("CVPixelBufferPoolCreate failed ({status})"));
        }
        self.target = Some(Target {
            size,
            bgra,
            texture,
            framebuffer,
            pool,
        });
        Ok(())
    }

    fn drop_target(&mut self) {
        let Some(target) = self.target.take() else {
            return;
        };
        let gl = self.gl();
        // SAFETY: objects this thread made, with their context current; the pool's buffers
        // already handed out stay valid on their own.
        unsafe {
            (gl.delete_framebuffers)(1, &raw const target.framebuffer);
            (gl.delete_textures)(1, &raw const target.texture);
            CFRelease(target.pool);
        }
    }
}

impl Backend for OpenGl {
    fn create(&mut self, core: &Core) -> Result<*mut ffi::RenderContext, String> {
        let gl = Gl::get()?;
        self.gl = Some(gl);
        let attributes = [
            CGL_PFA_OPENGL_PROFILE,
            CGL_OGLP_VERSION_GL4_CORE,
            CGL_PFA_ACCELERATED,
            CGL_PFA_ALLOW_OFFLINE_RENDERERS,
            0,
        ];
        let (mut format, mut formats) = (ptr::null_mut(), 0);
        // SAFETY: a zero-terminated attribute list and out pointers; the pixel format is
        // destroyed once the context holds it.
        unsafe {
            let status =
                (gl.choose_pixel_format)(attributes.as_ptr(), &raw mut format, &raw mut formats);
            if status != 0 || format.is_null() {
                return Err(format!("no OpenGL 4.1 pixel format ({status})"));
            }
            let status = (gl.create_context)(format, ptr::null_mut(), &raw mut self.cgl);
            (gl.destroy_pixel_format)(format);
            if status != 0 || self.cgl.is_null() {
                return Err(format!("CGLCreateContext failed ({status})"));
            }
            (gl.set_current_context)(self.cgl);
        }

        let mut session = ptr::null_mut();
        // SAFETY: an out pointer; the session is invalidated and released in `destroy`.
        let status = unsafe { VTPixelTransferSessionCreate(ptr::null(), &raw mut session) };
        if status != 0 || session.is_null() {
            return Err(format!("VTPixelTransferSessionCreate failed ({status})"));
        }
        self.session = session;
        // SAFETY: VideoToolbox's and CoreVideo's key constants with CFString values, as the
        // properties' documentation gives them.
        unsafe {
            for (key, value) in [
                (
                    kVTPixelTransferPropertyKey_DestinationYCbCrMatrix,
                    kCVImageBufferYCbCrMatrix_ITU_R_601_4,
                ),
                (
                    kVTPixelTransferPropertyKey_DestinationColorPrimaries,
                    kCVImageBufferColorPrimaries_ITU_R_709_2,
                ),
                (
                    kVTPixelTransferPropertyKey_DestinationTransferFunction,
                    kCVImageBufferTransferFunction_ITU_R_709_2,
                ),
            ] {
                VTSessionSetProperty(session, key, value);
            }
        }

        let init = ffi::OpenGlInitParams {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: ptr::from_ref(gl).cast_mut().cast(),
        };
        let mut params = [
            ffi::RenderParam::new(
                ffi::RENDER_PARAM_API_TYPE,
                ffi::RENDER_API_TYPE_OPENGL.as_ptr(),
            ),
            ffi::RenderParam::new(ffi::RENDER_PARAM_OPENGL_INIT_PARAMS, &raw const init),
            ffi::RenderParam::END,
        ];
        let mut context = ptr::null_mut();
        // SAFETY: a live core, this thread's current CGL context, and a terminated list.
        let status = unsafe {
            (core.api().render_context_create)(&raw mut context, core.handle(), params.as_mut_ptr())
        };
        if status < 0 || context.is_null() {
            return Err(format!(
                "mpv's OpenGL renderer would not start: {}",
                core.api().describe(status)
            ));
        }
        Ok(context)
    }

    fn draw(
        &mut self,
        core: &Core,
        context: *mut ffi::RenderContext,
        size: (u32, u32),
        timing: &[ffi::RenderParam],
    ) -> Result<Picture, String> {
        self.ensure_target(size)?;
        let gl = self.gl();
        let target = self.target.as_ref().expect("ensure_target made one");
        let fbo = ffi::OpenGlFbo {
            fbo: target.framebuffer as c_int,
            w: size.0 as c_int,
            h: size.1 as c_int,
            internal_format: GL_RGBA8,
        };
        // An IOSurface's first row is the top of the picture; an FBO's, mpv's unflipped one.
        let flip: c_int = 0;
        let mut params: Vec<ffi::RenderParam> = vec![
            ffi::RenderParam::new(ffi::RENDER_PARAM_OPENGL_FBO, &raw const fbo),
            ffi::RenderParam::new(ffi::RENDER_PARAM_FLIP_Y, &raw const flip),
        ];
        params.extend_from_slice(timing);
        params.push(ffi::RenderParam::END);
        // SAFETY: a live context on its render thread, with its CGL context current, and a
        // complete framebuffer of `size`.
        let status = unsafe { (core.api().render_context_render)(context, params.as_mut_ptr()) };
        if status < 0 {
            return Err(core.api().describe(status));
        }
        // VideoToolbox reads the IOSurface next, outside GL: GL's writes must have landed.
        // SAFETY: a plain GL call with the context current.
        unsafe { (gl.finish)() };

        let mut out = ptr::null_mut();
        // SAFETY: the pool `ensure_target` made, and an out pointer; the buffer is retained.
        let status =
            unsafe { CVPixelBufferPoolCreatePixelBuffer(ptr::null(), target.pool, &raw mut out) };
        let out = NonNull::new(out)
            .filter(|_| status == 0)
            .ok_or_else(|| format!("no 420f buffer from the pool ({status})"))?;
        // SAFETY: the pool returned a +1 reference.
        let out = unsafe { CFRetained::from_raw(out) };
        // SAFETY: a live session and two IOSurface-backed buffers of the same size.
        let status =
            unsafe { VTPixelTransferSessionTransferImage(self.session, &target.bgra, &out) };
        if status != 0 {
            return Err(format!(
                "VTPixelTransferSessionTransferImage failed ({status})"
            ));
        }
        tag_colours(&out, true);
        Ok(Picture::Buffer(PixelBuffer(out)))
    }

    fn destroy(&mut self) {
        if self.gl.is_none() {
            return;
        }
        self.drop_target();
        let gl = self.gl();
        // SAFETY: the session and context this thread made, each released once.
        unsafe {
            if !self.session.is_null() {
                VTPixelTransferSessionInvalidate(self.session);
                CFRelease(self.session);
                self.session = ptr::null_mut();
            }
            if !self.cgl.is_null() {
                (gl.set_current_context)(ptr::null_mut());
                (gl.destroy_context)(self.cgl);
                self.cgl = ptr::null_mut();
            }
        }
    }
}

/// Attributes for IOSurface-backed buffers of `format` that GL and Metal can both use.
fn buffer_attributes(
    size: (u32, u32),
    format: u32,
) -> objc2::rc::Retained<NSDictionary<NSString, AnyObject>> {
    let surface = NSDictionary::<NSString, AnyObject>::new();
    let yes = NSNumber::new_bool(true);
    let format = NSNumber::new_u32(format);
    let (width, height) = (NSNumber::new_u32(size.0), NSNumber::new_u32(size.1));
    // SAFETY: CoreVideo's own keys, with the value types its documentation gives.
    unsafe {
        let keys = [
            bridged(kCVPixelBufferPixelFormatTypeKey),
            bridged(kCVPixelBufferWidthKey),
            bridged(kCVPixelBufferHeightKey),
            bridged(kCVPixelBufferIOSurfacePropertiesKey),
            bridged(kCVPixelBufferOpenGLCompatibilityKey),
            bridged(kCVPixelBufferMetalCompatibilityKey),
        ];
        let values: [&AnyObject; 6] = [&format, &width, &height, &surface, &yes, &yes];
        NSDictionary::from_slices(&keys, &values)
    }
}

fn pixel_buffer(size: (u32, u32), format: u32) -> Result<CFRetained<CVPixelBuffer>, String> {
    let attributes = buffer_attributes(size, format);
    let mut buffer = ptr::null_mut();
    // SAFETY: a valid attributes dictionary and an out pointer for a +1 reference.
    let status = unsafe {
        CVPixelBufferCreate(
            None,
            size.0 as usize,
            size.1 as usize,
            format,
            Some(dictionary(&attributes)),
            NonNull::from(&mut buffer),
        )
    };
    let buffer = NonNull::new(buffer)
        .filter(|_| status == 0)
        .ok_or_else(|| format!("CVPixelBufferCreate failed ({status})"))?;
    // SAFETY: CVPixelBufferCreate returned a +1 reference.
    Ok(unsafe { CFRetained::from_raw(buffer) })
}

/// States BT.709 primaries and transfer on a buffer, and BT.601's matrix on a Y'CbCr one, so
/// VideoToolbox converts between the two without colour matching.
fn tag_colours(buffer: &CVPixelBuffer, ycbcr: bool) {
    // SAFETY: CoreVideo's attachment keys with the CFString values they take.
    unsafe {
        let set = |key: &CFString, value: &CFString| {
            buffer.set_attachment(key, value, CVAttachmentMode::ShouldPropagate);
        };
        set(
            kCVImageBufferColorPrimariesKey,
            kCVImageBufferColorPrimaries_ITU_R_709_2,
        );
        set(
            kCVImageBufferTransferFunctionKey,
            kCVImageBufferTransferFunction_ITU_R_709_2,
        );
        if ycbcr {
            set(
                kCVImageBufferYCbCrMatrixKey,
                kCVImageBufferYCbCrMatrix_ITU_R_601_4,
            );
        }
    }
}

/// A CoreFoundation string as the Foundation string it is (the two are toll-free bridged).
fn bridged(key: &CFString) -> &NSString {
    // SAFETY: every CFString is an NSString.
    unsafe { &*ptr::from_ref(key).cast::<NSString>() }
}

/// A Foundation dictionary as the CoreFoundation one it is.
fn dictionary(dictionary: &NSDictionary<NSString, AnyObject>) -> &CFDictionary {
    // SAFETY: every NSDictionary is a CFDictionary.
    unsafe { &*ptr::from_ref(dictionary).cast::<CFDictionary>() }
}
