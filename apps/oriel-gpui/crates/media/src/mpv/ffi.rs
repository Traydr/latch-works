//! libmpv's client API (`client.h`) and render API (`render.h`, `render_gl.h`), written by hand
//! from mpv v0.41.0's headers, client API 2.5, for the calls the player makes, and loaded at run
//! time.
//!
//! Nothing here is linked at build time. [`Libmpv::get`] opens the dylib once per process and
//! keeps it for good: mpv runs threads of its own, so unloading it while any could still run
//! would be unsound. On this Mac the library is IINA's, read in place from its app bundle. Its
//! dependencies are named `@rpath/…` and carry no rpath of their own (IINA's executable supplies
//! it), so each one dyld reports missing is loaded first from the same folder, by full path; dyld
//! then matches the later `@rpath/` reference to the image already loaded under that name.

use std::ffi::{CStr, c_char, c_double, c_int, c_ulong, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;

/// `mpv_handle`, only ever behind a pointer.
pub(super) type Handle = c_void;
/// `mpv_render_context`, only ever behind a pointer.
pub(super) type RenderContext = c_void;

/// `MPV_MAKE_VERSION(2, 5)`: the headers this file follows.
pub(super) const CLIENT_API_VERSION: c_ulong = (2 << 16) | 5;

// `mpv_format`.
pub(super) const FORMAT_STRING: c_int = 1;
pub(super) const FORMAT_FLAG: c_int = 3;
pub(super) const FORMAT_INT64: c_int = 4;
pub(super) const FORMAT_DOUBLE: c_int = 5;

// `mpv_event_id`.
pub(super) const EVENT_NONE: c_int = 0;
pub(super) const EVENT_SHUTDOWN: c_int = 1;
pub(super) const EVENT_LOG_MESSAGE: c_int = 2;
pub(super) const EVENT_COMMAND_REPLY: c_int = 5;
pub(super) const EVENT_END_FILE: c_int = 7;
pub(super) const EVENT_FILE_LOADED: c_int = 8;
pub(super) const EVENT_PLAYBACK_RESTART: c_int = 21;
pub(super) const EVENT_PROPERTY_CHANGE: c_int = 22;

// `mpv_end_file_reason`.
pub(super) const END_FILE_REASON_ERROR: c_int = 4;

// `mpv_render_param_type`.
pub(super) const RENDER_PARAM_INVALID: c_int = 0;
pub(super) const RENDER_PARAM_API_TYPE: c_int = 1;
pub(super) const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub(super) const RENDER_PARAM_OPENGL_FBO: c_int = 3;
pub(super) const RENDER_PARAM_FLIP_Y: c_int = 4;
pub(super) const RENDER_PARAM_NEXT_FRAME_INFO: c_int = 11;
pub(super) const RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;
pub(super) const RENDER_PARAM_SKIP_RENDERING: c_int = 13;
pub(super) const RENDER_PARAM_SW_SIZE: c_int = 17;
pub(super) const RENDER_PARAM_SW_FORMAT: c_int = 18;
pub(super) const RENDER_PARAM_SW_STRIDE: c_int = 19;
pub(super) const RENDER_PARAM_SW_POINTER: c_int = 20;

/// `MPV_RENDER_API_TYPE_OPENGL`.
pub(super) const RENDER_API_TYPE_OPENGL: &CStr = c"opengl";
/// `MPV_RENDER_API_TYPE_SW`.
pub(super) const RENDER_API_TYPE_SW: &CStr = c"sw";

/// `MPV_RENDER_UPDATE_FRAME`: a new picture is due, so `mpv_render_context_render` must run.
pub(super) const RENDER_UPDATE_FRAME: u64 = 1;
/// `MPV_RENDER_FRAME_INFO_PRESENT`: there is a next frame at all.
pub(super) const RENDER_FRAME_INFO_PRESENT: u64 = 1;
/// `MPV_RENDER_FRAME_INFO_REDRAW`: the next frame redraws the last one (paused, say).
pub(super) const RENDER_FRAME_INFO_REDRAW: u64 = 1 << 1;

/// `mpv_event`.
#[repr(C)]
pub(super) struct Event {
    pub(super) event_id: c_int,
    pub(super) error: c_int,
    pub(super) reply_userdata: u64,
    pub(super) data: *mut c_void,
}

/// `mpv_event_property`.
#[repr(C)]
pub(super) struct EventProperty {
    pub(super) name: *const c_char,
    pub(super) format: c_int,
    pub(super) data: *mut c_void,
}

/// `mpv_event_end_file`.
#[repr(C)]
pub(super) struct EventEndFile {
    pub(super) reason: c_int,
    pub(super) error: c_int,
    pub(super) playlist_entry_id: i64,
    pub(super) playlist_insert_id: i64,
    pub(super) playlist_insert_num_entries: c_int,
}

/// `mpv_event_log_message`.
#[repr(C)]
pub(super) struct EventLogMessage {
    pub(super) prefix: *const c_char,
    pub(super) level: *const c_char,
    pub(super) text: *const c_char,
    pub(super) log_level: c_int,
}

/// `mpv_render_param`: a type and a pointer to its value; arrays end with type 0.
#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct RenderParam {
    pub(super) kind: c_int,
    pub(super) data: *mut c_void,
}

impl RenderParam {
    pub(super) fn new<T>(kind: c_int, data: *const T) -> Self {
        Self {
            kind,
            data: data.cast_mut().cast(),
        }
    }

    pub(super) const END: RenderParam = RenderParam {
        kind: RENDER_PARAM_INVALID,
        data: std::ptr::null_mut(),
    };
}

/// `mpv_opengl_init_params`.
#[repr(C)]
pub(super) struct OpenGlInitParams {
    pub(super) get_proc_address:
        Option<unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void>,
    pub(super) get_proc_address_ctx: *mut c_void,
}

/// `mpv_opengl_fbo`.
#[repr(C)]
pub(super) struct OpenGlFbo {
    pub(super) fbo: c_int,
    pub(super) w: c_int,
    pub(super) h: c_int,
    pub(super) internal_format: c_int,
}

/// `mpv_render_frame_info`.
#[repr(C)]
#[derive(Default)]
pub(super) struct RenderFrameInfo {
    pub(super) flags: u64,
    /// When mpv means the frame to be on screen; 0 for redraws. The header says on
    /// `mpv_get_time_us`'s clock, but v0.41.0 gives `mpv_get_time_ns` (see `render.rs`).
    pub(super) target_time: i64,
}

/// `mpv_render_update_fn`.
pub(super) type UpdateCallback = unsafe extern "C" fn(ctx: *mut c_void);

/// The libmpv functions the player calls, each with its C signature from the headers.
pub(super) struct Libmpv {
    pub(super) client_api_version: unsafe extern "C" fn() -> c_ulong,
    pub(super) error_string: unsafe extern "C" fn(error: c_int) -> *const c_char,
    pub(super) free: unsafe extern "C" fn(data: *mut c_void),
    pub(super) create: unsafe extern "C" fn() -> *mut Handle,
    pub(super) initialize: unsafe extern "C" fn(ctx: *mut Handle) -> c_int,
    pub(super) terminate_destroy: unsafe extern "C" fn(ctx: *mut Handle),
    pub(super) set_option_string:
        unsafe extern "C" fn(ctx: *mut Handle, name: *const c_char, data: *const c_char) -> c_int,
    pub(super) command_async:
        unsafe extern "C" fn(ctx: *mut Handle, reply: u64, args: *mut *const c_char) -> c_int,
    pub(super) set_property_async: unsafe extern "C" fn(
        ctx: *mut Handle,
        reply: u64,
        name: *const c_char,
        format: c_int,
        data: *mut c_void,
    ) -> c_int,
    pub(super) get_property: unsafe extern "C" fn(
        ctx: *mut Handle,
        name: *const c_char,
        format: c_int,
        data: *mut c_void,
    ) -> c_int,
    pub(super) get_property_string:
        unsafe extern "C" fn(ctx: *mut Handle, name: *const c_char) -> *mut c_char,
    pub(super) observe_property: unsafe extern "C" fn(
        ctx: *mut Handle,
        reply: u64,
        name: *const c_char,
        format: c_int,
    ) -> c_int,
    pub(super) request_log_messages:
        unsafe extern "C" fn(ctx: *mut Handle, min_level: *const c_char) -> c_int,
    pub(super) wait_event: unsafe extern "C" fn(ctx: *mut Handle, timeout: c_double) -> *mut Event,
    pub(super) get_time_ns: unsafe extern "C" fn(ctx: *mut Handle) -> i64,
    pub(super) render_context_create: unsafe extern "C" fn(
        res: *mut *mut RenderContext,
        mpv: *mut Handle,
        params: *mut RenderParam,
    ) -> c_int,
    pub(super) render_context_set_update_callback: unsafe extern "C" fn(
        ctx: *mut RenderContext,
        callback: Option<UpdateCallback>,
        callback_ctx: *mut c_void,
    ),
    pub(super) render_context_update: unsafe extern "C" fn(ctx: *mut RenderContext) -> u64,
    pub(super) render_context_render:
        unsafe extern "C" fn(ctx: *mut RenderContext, params: *mut RenderParam) -> c_int,
    pub(super) render_context_get_info:
        unsafe extern "C" fn(ctx: *mut RenderContext, param: RenderParam) -> c_int,
    pub(super) render_context_free: unsafe extern "C" fn(ctx: *mut RenderContext),
    /// Where the library was loaded from.
    pub(super) path: PathBuf,
    // The library and the dependencies loaded for it, never unloaded (see the module docs).
    _libraries: Vec<Library>,
}

/// IINA's own libmpv, in the place IINA installs to.
const IINA_LIBMPV: &str = "/Applications/IINA.app/Contents/Frameworks/libmpv.2.dylib";
/// Names a libmpv to load instead of IINA's.
pub(super) const LIBMPV_VARIABLE: &str = "ORIEL_GPUI_LIBMPV";

static LIBMPV: OnceLock<Result<Libmpv, String>> = OnceLock::new();

impl Libmpv {
    /// The process's libmpv, loaded on first use from `ORIEL_GPUI_LIBMPV` or IINA's bundle.
    pub(super) fn get() -> Result<&'static Libmpv, String> {
        LIBMPV
            .get_or_init(|| {
                let path = std::env::var_os(LIBMPV_VARIABLE)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(IINA_LIBMPV));
                Libmpv::load(&path)
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    fn load(path: &Path) -> Result<Libmpv, String> {
        if !path.is_file() {
            return Err(format!(
                "no libmpv at {} (set {LIBMPV_VARIABLE} to one)",
                path.display()
            ));
        }
        let folder = path.parent().unwrap_or(Path::new("/"));
        let mut libraries = Vec::new();
        let library = open_with_dependencies(path, folder, &mut libraries, 0)?;

        /// Looks a function up by name. The caller states its signature, which must be mpv's.
        unsafe fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T, String> {
            let name = format!("{name}\0");
            // SAFETY: the caller's type is the function's C signature.
            unsafe { library.get::<T>(name.as_bytes()) }
                .map(|symbol| *symbol)
                .map_err(|error| format!("libmpv has no {}: {error}", name.trim_end_matches('\0')))
        }

        // SAFETY: each type is the C signature the v0.41.0 headers give the function named.
        let api = unsafe {
            Libmpv {
                client_api_version: symbol(&library, "mpv_client_api_version")?,
                error_string: symbol(&library, "mpv_error_string")?,
                free: symbol(&library, "mpv_free")?,
                create: symbol(&library, "mpv_create")?,
                initialize: symbol(&library, "mpv_initialize")?,
                terminate_destroy: symbol(&library, "mpv_terminate_destroy")?,
                set_option_string: symbol(&library, "mpv_set_option_string")?,
                command_async: symbol(&library, "mpv_command_async")?,
                set_property_async: symbol(&library, "mpv_set_property_async")?,
                get_property: symbol(&library, "mpv_get_property")?,
                get_property_string: symbol(&library, "mpv_get_property_string")?,
                observe_property: symbol(&library, "mpv_observe_property")?,
                request_log_messages: symbol(&library, "mpv_request_log_messages")?,
                wait_event: symbol(&library, "mpv_wait_event")?,
                get_time_ns: symbol(&library, "mpv_get_time_ns")?,
                render_context_create: symbol(&library, "mpv_render_context_create")?,
                render_context_set_update_callback: symbol(
                    &library,
                    "mpv_render_context_set_update_callback",
                )?,
                render_context_update: symbol(&library, "mpv_render_context_update")?,
                render_context_render: symbol(&library, "mpv_render_context_render")?,
                render_context_get_info: symbol(&library, "mpv_render_context_get_info")?,
                render_context_free: symbol(&library, "mpv_render_context_free")?,
                path: path.to_path_buf(),
                _libraries: Vec::new(),
            }
        };
        // The same major version keeps every call above; a lower minor may lack one.
        // SAFETY: a plain call with no arguments.
        let version = unsafe { (api.client_api_version)() };
        if version >> 16 != CLIENT_API_VERSION >> 16 || version < CLIENT_API_VERSION {
            return Err(format!(
                "libmpv's client API is {}.{}; this player needs 2.5 or a later 2.x",
                version >> 16,
                version & 0xffff
            ));
        }
        libraries.push(library);
        Ok(Libmpv {
            _libraries: libraries,
            ..api
        })
    }

    /// The client API version the library reports, as `major.minor`.
    pub(super) fn client_api(&self) -> String {
        // SAFETY: a plain call with no arguments.
        let version = unsafe { (self.client_api_version)() };
        format!("{}.{}", version >> 16, version & 0xffff)
    }

    /// mpv's words for an error code.
    pub(super) fn describe(&self, error: c_int) -> String {
        // SAFETY: mpv returns a static string for any code.
        unsafe { CStr::from_ptr((self.error_string)(error)) }
            .to_string_lossy()
            .into_owned()
    }
}

/// Opens `path`, first opening from `folder` each `@rpath/` dependency dyld says is missing.
fn open_with_dependencies(
    path: &Path,
    folder: &Path,
    held: &mut Vec<Library>,
    depth: usize,
) -> Result<Library, String> {
    let mut tried: Vec<String> = Vec::new();
    loop {
        // SAFETY: loading a dylib runs its initialisers. IINA's libraries have no
        // preconditions; their dependencies come first, from the same signed bundle.
        let message = match unsafe { Library::new(path) } {
            Ok(library) => return Ok(library),
            Err(error) => error.to_string(),
        };
        let missing = missing_rpath_library(&message)
            .filter(|name| depth < 32 && !tried.iter().any(|tried| tried == name))
            .filter(|name| folder.join(name).is_file());
        let Some(name) = missing else {
            return Err(format!("could not load {}: {message}", path.display()));
        };
        tried.push(name.to_owned());
        let library = open_with_dependencies(&folder.join(name), folder, held, depth + 1)?;
        held.push(library);
    }
}

/// The file name in dyld's "Library not loaded: @rpath/libass.9.dylib".
fn missing_rpath_library(message: &str) -> Option<&str> {
    let (_, rest) = message.split_once("Library not loaded: @rpath/")?;
    rest.split(|c: char| c.is_whitespace() || c == '\'')
        .next()
        .filter(|name| !name.is_empty() && !name.contains('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// dyld names one missing dependency per failure; the loader retries after loading it.
    #[test]
    fn reads_the_missing_library_from_dylds_message() {
        let message = "dlopen(/Applications/IINA.app/Contents/Frameworks/libmpv.2.dylib, 0x0005): \
            Library not loaded: @rpath/libass.9.dylib\n  Referenced from: <UUID> /x/libmpv.2.dylib";
        assert_eq!(missing_rpath_library(message), Some("libass.9.dylib"));
        assert_eq!(missing_rpath_library("image not found"), None);
        assert_eq!(
            missing_rpath_library("Library not loaded: /usr/lib/libz.1.dylib"),
            None
        );
    }
}
