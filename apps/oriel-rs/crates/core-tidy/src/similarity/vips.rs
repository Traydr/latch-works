//! libvips through its C API, asked for exactly what sharp 0.35 asks it for when glazier-core
//! calls
//!
//! ```text
//! sharp(path, { failOn: "none", limitInputPixels: false, page })
//!   .rotate().flatten({ background: "#ffffff" })
//!   .resize(n, n, { fit: "fill", kernel: "lanczos3" }).greyscale().raw()
//! ```
//!
//! sharp does not run those steps in the order they are written. Its `pipeline.cc` opens the file,
//! reloads a JPEG or WebP shrunk on load, converts an embedded ICC profile (or CMYK) to sRGB,
//! flattens, turns grey, resizes, and only then turns and mirrors for EXIF orientation. It ends
//! by converting to sRGB and taking the first band. Each step below names the sharp code it
//! mirrors. Fingerprints equal glazier-core's bit for bit only with the libvips sharp ships, since
//! decoders and colour management change between releases: 8.17 already prints CMYK differently.
//!
//! libvips is LGPL, so it is loaded at run time from a dylib the app ships beside itself rather
//! than linked in. Its options are passed as C varargs, as every libvips binding does.

use std::{
    error::Error,
    ffi::{CStr, CString, c_char, c_double, c_int, c_void},
    fmt,
    path::{Path, PathBuf},
    ptr::{self, NonNull},
    slice,
    sync::{Mutex, OnceLock},
};

use libloading::Library;

/// A libvips call that failed, with libvips' own message when it gave one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VipsError(pub String);

impl fmt::Display for VipsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for VipsError {}

type Result<T> = std::result::Result<T, VipsError>;

type GType = usize;

/// `G_TYPE_INT`: fundamental type 6, shifted by `G_TYPE_FUNDAMENTAL_SHIFT`.
const G_TYPE_INT: GType = 6 << 2;

/// `VImage` in sharp; only ever handled through [`Image`].
type RawImage = c_void;

/// One out-parameter operation: `int vips_x(VipsImage *in, VipsImage **out, ...)`.
type Operation = unsafe extern "C" fn(*mut RawImage, *mut *mut RawImage, ...) -> c_int;

/// One with a fixed int argument after `out`: `vips_rot`, `vips_cast`, `vips_colourspace`…
type IntOperation = unsafe extern "C" fn(*mut RawImage, *mut *mut RawImage, c_int, ...) -> c_int;

/// A loader: `int vips_jpegload(const char *filename, VipsImage **out, ...)`.
type Loader = unsafe extern "C" fn(*const c_char, *mut *mut RawImage, ...) -> c_int;

/// The libvips enum values this uses, read from libvips by name when it loads.
struct Enums {
    access_sequential: c_int,
    fail_on_none: c_int,
    kernel_lanczos3: c_int,
    intent_perceptual: c_int,
    direction_horizontal: c_int,
    angle_d0: c_int,
    angle_d90: c_int,
    angle_d180: c_int,
    angle_d270: c_int,
    format_uchar: c_int,
    format_ushort: c_int,
    b_w: c_int,
    srgb: c_int,
    rgb16: c_int,
    grey16: c_int,
    labs: c_int,
    cmyk: c_int,
}

struct Api {
    error_buffer: unsafe extern "C" fn() -> *const c_char,
    error_clear: unsafe extern "C" fn(),
    object_unref: unsafe extern "C" fn(*mut c_void),
    g_free: unsafe extern "C" fn(*mut c_void),
    version: unsafe extern "C" fn(c_int) -> c_int,
    find_load: unsafe extern "C" fn(*const c_char) -> *const c_char,
    new_from_file: unsafe extern "C" fn(*const c_char, ...) -> *mut RawImage,
    jpegload: Loader,
    webpload: Loader,
    get_typeof: unsafe extern "C" fn(*const RawImage, *const c_char) -> GType,
    get_int: unsafe extern "C" fn(*const RawImage, *const c_char, *mut c_int) -> c_int,
    get_array_int:
        unsafe extern "C" fn(*mut RawImage, *const c_char, *mut *mut c_int, *mut c_int) -> c_int,
    remove: unsafe extern "C" fn(*mut RawImage, *const c_char) -> c_int,
    width: unsafe extern "C" fn(*const RawImage) -> c_int,
    height: unsafe extern "C" fn(*const RawImage) -> c_int,
    bands: unsafe extern "C" fn(*const RawImage) -> c_int,
    format: unsafe extern "C" fn(*const RawImage) -> c_int,
    interpretation: unsafe extern "C" fn(*const RawImage) -> c_int,
    has_alpha: unsafe extern "C" fn(*mut RawImage) -> c_int,
    page_height: unsafe extern "C" fn(*mut RawImage) -> c_int,
    is_sequential: unsafe extern "C" fn(*mut RawImage) -> c_int,
    copy_memory: unsafe extern "C" fn(*mut RawImage) -> *mut RawImage,
    write_to_memory: unsafe extern "C" fn(*mut RawImage, *mut usize) -> *mut c_void,
    /// `VIPS_TYPE_BLOB`, the type of an embedded ICC profile.
    blob_type: GType,
    /// `VIPS_TYPE_ARRAY_INT`, the type of an animation's delays.
    array_int_type: GType,
    array_double_new: unsafe extern "C" fn(*const c_double, c_int) -> *mut c_void,
    area_unref: unsafe extern "C" fn(*mut c_void),
    copy: Operation,
    flatten: Operation,
    premultiply: Operation,
    unpremultiply: Operation,
    icc_transform:
        unsafe extern "C" fn(*mut RawImage, *mut *mut RawImage, *const c_char, ...) -> c_int,
    resize: unsafe extern "C" fn(*mut RawImage, *mut *mut RawImage, c_double, ...) -> c_int,
    colourspace: IntOperation,
    rot: IntOperation,
    flip: IntOperation,
    cast: IntOperation,
    extract_band: IntOperation,
    /// `vips_bandjoin_const1`: appends one constant band, as sharp's `EnsureAlpha` does.
    bandjoin_const1:
        unsafe extern "C" fn(*mut RawImage, *mut *mut RawImage, c_double, ...) -> c_int,
    /// `vips_interpretation_max_alpha`: the opaque alpha value of an interpretation.
    max_alpha: unsafe extern "C" fn(c_int) -> c_double,
    enums: Enums,
}

/// libvips' `vips_init` is not safe to race.
static INIT: Mutex<()> = Mutex::new(());

/// libvips, from one dylib. It is `Send` and `Sync`, as libvips is: the passes decode a file per
/// core. One made by [`Vips::deferred`] loads the dylib the first time it is asked for anything,
/// so an app that never decodes a picture never pays for it (4 MB resident at launch).
pub struct Vips {
    path: PathBuf,
    loaded: OnceLock<Result<Loaded>>,
}

/// A loaded and started libvips.
struct Loaded {
    api: Api,
    // Declared last, so the library is unloaded after nothing can call into it.
    _library: Library,
}

/// What sharp calls the format behind a loader: it decides which load options apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageType {
    Jpeg,
    Png,
    Webp,
    Tiff,
    Gif,
    Heif,
    Jp2,
    Other,
}

impl ImageType {
    /// sharp's `loaderToType`, for file loaders. Ultra HDR JPEGs count as JPEG, as sharp has it.
    fn of_loader(name: &str) -> Option<ImageType> {
        Some(match name {
            "VipsForeignLoadJpegFile" | "VipsForeignLoadUhdr" | "VipsForeignLoadUhdrFile" => {
                ImageType::Jpeg
            }
            "VipsForeignLoadPngFile" => ImageType::Png,
            "VipsForeignLoadWebpFile" => ImageType::Webp,
            "VipsForeignLoadTiffFile" => ImageType::Tiff,
            "VipsForeignLoadGifFile" | "VipsForeignLoadNsgifFile" => ImageType::Gif,
            "VipsForeignLoadHeifFile" => ImageType::Heif,
            "VipsForeignLoadJp2kFile" => ImageType::Jp2,
            "VipsForeignLoadSvgFile"
            | "VipsForeignLoadPdfFile"
            | "VipsForeignLoadMagickFile"
            | "VipsForeignLoadMagick7File"
            | "VipsForeignLoadOpenslideFile"
            | "VipsForeignLoadPpmFile"
            | "VipsForeignLoadFitsFile"
            | "VipsForeignLoadOpenexr"
            | "VipsForeignLoadJxlFile"
            | "VipsForeignLoadRadFile"
            | "VipsForeignLoadDcRawFile"
            | "VipsForeignLoadVips"
            | "VipsForeignLoadVipsFile"
            | "VipsForeignLoadRaw" => ImageType::Other,
            _ => return None,
        })
    }

    /// sharp's `ImageTypeSupportsPage`, for the types this can meet.
    fn supports_page(self) -> bool {
        matches!(
            self,
            ImageType::Webp | ImageType::Gif | ImageType::Jp2 | ImageType::Tiff | ImageType::Heif
        )
    }
}

/// An image's header, as glazier-core's `probeImage` reads it from sharp's `metadata()`. The
/// similar-set search bins pictures by `width / height`, so these feed its thresholds too.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageProbe {
    /// Display dimensions: after EXIF orientation, and one page's for an animation.
    pub width: u32,
    pub height: u32,
    /// 1 for a still; the frame count of an animated GIF, WebP or PNG.
    pub frames: u32,
    pub has_alpha: bool,
    /// Per-frame display times in milliseconds for an animation, as the file states them.
    pub frame_delays_ms: Vec<i32>,
}

/// An owned `VipsImage` reference.
struct Image<'a> {
    api: &'a Api,
    raw: NonNull<RawImage>,
}

impl Drop for Image<'_> {
    fn drop(&mut self) {
        // SAFETY: `raw` is a reference this owns, from a libvips constructor or operation.
        unsafe { (self.api.object_unref)(self.raw.as_ptr()) }
    }
}

impl Image<'_> {
    fn ptr(&self) -> *mut RawImage {
        self.raw.as_ptr()
    }

    fn width(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.width)(self.ptr()) }
    }

    fn height(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.height)(self.ptr()) }
    }

    fn bands(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.bands)(self.ptr()) }
    }

    fn format(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.format)(self.ptr()) }
    }

    fn interpretation(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.interpretation)(self.ptr()) }
    }

    fn has_alpha(&self) -> bool {
        // SAFETY: a live image.
        unsafe { (self.api.has_alpha)(self.ptr()) != 0 }
    }

    fn page_height(&self) -> c_int {
        // SAFETY: a live image.
        unsafe { (self.api.page_height)(self.ptr()) }
    }

    fn type_of(&self, field: &CStr) -> GType {
        // SAFETY: a live image and a NUL-terminated name.
        unsafe { (self.api.get_typeof)(self.ptr(), field.as_ptr()) }
    }

    /// An int field, when the image has one of that type.
    fn int_field(&self, field: &CStr) -> Option<c_int> {
        if self.type_of(field) != G_TYPE_INT {
            return None;
        }
        let mut value = 0;
        // SAFETY: a live image, a NUL-terminated name and a place for the answer.
        let failed = unsafe { (self.api.get_int)(self.ptr(), field.as_ptr(), &mut value) } != 0;
        if failed {
            // SAFETY: plain call.
            unsafe { (self.api.error_clear)() };
            return None;
        }
        Some(value)
    }
}

impl Vips {
    /// Loads libvips from `library` (sharp's `libvips-cpp.*.dylib`, say) and starts it.
    pub fn open(library: &Path) -> Result<Vips> {
        Ok(Vips {
            path: library.to_path_buf(),
            loaded: OnceLock::from(Ok(Loaded::open(library)?)),
        })
    }

    /// libvips from `library`, loaded and started the first time it is used, and then refused,
    /// as [`Vips::open_located`] refuses it, if it is not sharp's 8.18 line.
    pub fn deferred(library: &Path) -> Vips {
        Vips {
            path: library.to_path_buf(),
            loaded: OnceLock::new(),
        }
    }

    fn loaded(&self) -> Result<&Loaded> {
        self.loaded
            .get_or_init(|| {
                let loaded = Loaded::open(&self.path).and_then(|loaded| {
                    let version = loaded.version();
                    if !accepts_libvips_version(&version) {
                        return Err(VipsError(format!(
                            "libvips {version} ({}) is not 8.18.x, so its fingerprints would not \
                             be glazier-core's",
                            self.path.display()
                        )));
                    }
                    log::info!("libvips {version} loaded from {}", self.path.display());
                    Ok(loaded)
                });
                if let Err(error) = &loaded {
                    log::warn!("Tidy runs without libvips: {error}");
                }
                loaded
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    /// Whether libvips loads, loading it now if it has not yet.
    pub fn loads(&self) -> bool {
        self.loaded().is_ok()
    }

    /// The dylib it loads from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Its version once loaded, without loading it.
    pub fn loaded_version(&self) -> Option<String> {
        match self.loaded.get() {
            Some(Ok(loaded)) => Some(loaded.version()),
            _ => None,
        }
    }

    /// The loaded libvips' version, as `major.minor.micro`; empty when it does not load.
    pub fn version(&self) -> String {
        self.loaded()
            .map_or_else(|_| String::new(), Loaded::version)
    }

    /// A picture as `size`×`size` grey, the way glazier-core's `greyPixels` reads it: EXIF
    /// orientation applied and transparency laid on white. `page` picks an animation's frame.
    pub fn grey_pixels(&self, path: &Path, size: u32, page: Option<u32>) -> Result<Vec<u8>> {
        self.loaded()?.grey_pixels(path, size, page)
    }

    /// A still as 8-bit sRGB RGBA, rows top to bottom, as Convert decodes it for the encoder.
    pub fn rgba_pixels(&self, path: &Path) -> Result<(u32, u32, Vec<u8>)> {
        self.loaded()?.rgba_pixels(path)
    }

    /// What the probe pass reads of a picture: its size, frames, alpha and frame delays.
    pub fn probe(&self, path: &Path) -> Result<ImageProbe> {
        self.loaded()?.probe(path)
    }
}

impl Loaded {
    /// Loads libvips from `library` and starts it.
    fn open(library: &Path) -> Result<Loaded> {
        // SAFETY: loading libvips runs its initialisers, which have no preconditions.
        let library = unsafe { Library::new(library) }
            .map_err(|error| VipsError(format!("Could not load libvips: {error}")))?;

        {
            let _guard = INIT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let init: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> c_int> =
                // SAFETY: `vips_init` has this signature in every libvips 8.
                unsafe { library.get(b"vips_init\0") }
                    .map_err(|error| VipsError(format!("libvips has no vips_init: {error}")))?;
            // SAFETY: serialised by INIT; libvips ignores calls after the first.
            if unsafe { init(c"oriel-rs".as_ptr()) } != 0 {
                return Err(VipsError("libvips would not start.".into()));
            }
            let set_cache_max: libloading::Symbol<unsafe extern "C" fn(c_int)> =
                // SAFETY: `vips_cache_set_max` has this signature in every libvips 8.
                unsafe { library.get(b"vips_cache_set_max\0") }.map_err(|error| {
                    VipsError(format!("libvips has no vips_cache_set_max: {error}"))
                })?;
            // Tidy rewrites files in place, so a cached load could describe bytes that are gone.
            // The cache never changes a result, only whether it is made again.
            // SAFETY: plain call after vips_init.
            unsafe { set_cache_max(0) };
        }

        let api = Api::load(&library)?;
        Ok(Loaded {
            api,
            _library: library,
        })
    }

    /// The loaded libvips' version, as `major.minor.micro`.
    fn version(&self) -> String {
        // SAFETY: plain calls.
        let part = |flag| unsafe { (self.api.version)(flag) };
        format!("{}.{}.{}", part(0), part(1), part(2))
    }

    /// A picture as `size`×`size` grey, the way glazier-core's `greyPixels` reads it: EXIF
    /// orientation applied and transparency laid on white. `page` picks an animation's frame.
    fn grey_pixels(&self, path: &Path, size: u32, page: Option<u32>) -> Result<Vec<u8>> {
        let size = c_int::try_from(size).map_err(|_| VipsError("Too large a size.".into()))?;
        let page = match page {
            Some(page) => c_int::try_from(page).map_err(|_| VipsError("No such page.".into()))?,
            None => -1,
        };
        let file = file_name(path)?;
        let api = &self.api;
        let enums = &api.enums;

        // OpenInput.
        let (mut image, image_type) = self.open_input(&file, page)?;

        // pipeline.cc: EXIF orientation, worked out now and applied after the resize.
        let (rotation, flop) = exif_rotation(enums, image.int_field(c"orientation"));

        // Shrink on load: JPEG by 2, 4 or 8, WebP by any scale, when the resize allows it.
        let (hshrink, vshrink) = resolve_shrink(image.width(), image.height(), size);
        let shrink = hshrink.min(vshrink);
        let mut jpeg_shrink = 1;
        let mut scale = 1.0;
        match image_type {
            ImageType::Jpeg => {
                // fastShrinkOnLoad is on, so a factor of 1, not 2, is left for the resize.
                jpeg_shrink = if shrink >= 8.0 {
                    8
                } else if shrink >= 4.0 {
                    4
                } else if shrink >= 2.0 {
                    2
                } else {
                    1
                };
                // Known libjpeg rounding errors at exact factors.
                if jpeg_shrink > 1 && shrink as c_int == jpeg_shrink {
                    jpeg_shrink /= 2;
                }
            }
            ImageType::Webp if shrink > 1.0 => scale = 1.0 / shrink,
            _ => {}
        }
        if jpeg_shrink > 1 {
            image = self.load(|out| {
                // SAFETY: `vips_jpegload` with sharp's options, NULL-terminated.
                unsafe {
                    (api.jpegload)(
                        file.as_ptr(),
                        out,
                        c"access".as_ptr(),
                        enums.access_sequential,
                        c"fail_on".as_ptr(),
                        enums.fail_on_none,
                        c"shrink".as_ptr(),
                        jpeg_shrink,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        } else if scale != 1.0 {
            image = self.load(|out| {
                // SAFETY: `vips_webpload` with sharp's options, NULL-terminated.
                unsafe {
                    (api.webpload)(
                        file.as_ptr(),
                        out,
                        c"access".as_ptr(),
                        enums.access_sequential,
                        c"fail_on".as_ptr(),
                        enums.fail_on_none,
                        c"n".as_ptr(),
                        1 as c_int,
                        c"page".as_ptr(),
                        page.max(0),
                        c"scale".as_ptr(),
                        scale,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }
        // sharp now drops the orientation and any gain map from the metadata, which changes no
        // pixel here.

        let (hshrink, vshrink) = resolve_shrink(image.width(), image.page_height(), size);

        // To a device-independent space: the embedded profile, else CMYK's default one.
        let interpretation = image.interpretation();
        let processing_profile = if interpretation == enums.rgb16 {
            c"p3"
        } else {
            c"srgb"
        };
        let has_profile = image.type_of(c"icc-profile-data") == api.blob_type;
        if has_profile && interpretation != enums.labs && interpretation != enums.grey16 {
            let depth: c_int = if self.is_16_bit(interpretation) {
                16
            } else {
                8
            };
            let transformed = self.apply(&image, |input, out| {
                // SAFETY: `vips_icc_transform` with sharp's options, NULL-terminated.
                unsafe {
                    (api.icc_transform)(
                        input,
                        out,
                        processing_profile.as_ptr(),
                        c"embedded".as_ptr(),
                        1 as c_int,
                        c"depth".as_ptr(),
                        depth,
                        c"intent".as_ptr(),
                        enums.intent_perceptual,
                        ptr::null::<c_char>(),
                    )
                }
            });
            // sharp warns "Invalid embedded profile" and carries on with the pixels as they are.
            if let Ok(transformed) = transformed {
                image = transformed;
            }
        } else if interpretation == enums.cmyk {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_icc_transform` with sharp's options, NULL-terminated.
                unsafe {
                    (api.icc_transform)(
                        input,
                        out,
                        processing_profile.as_ptr(),
                        c"input_profile".as_ptr(),
                        c"cmyk".as_ptr(),
                        c"intent".as_ptr(),
                        enums.intent_perceptual,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }

        // Flatten onto white. sharp scales 8-bit white by 256 for 16-bit images, so it is 65280.
        if image.has_alpha() {
            let white = if self.is_16_bit(image.interpretation()) {
                255.0 * 256.0
            } else {
                255.0
            };
            let background = [white; 3];
            // SAFETY: three doubles, copied by libvips.
            let array = unsafe { (api.array_double_new)(background.as_ptr(), 3) };
            let flattened = self.apply(&image, |input, out| {
                // SAFETY: `vips_flatten` with a VipsArrayDouble background, NULL-terminated.
                unsafe {
                    (api.flatten)(
                        input,
                        out,
                        c"background".as_ptr(),
                        array,
                        ptr::null::<c_char>(),
                    )
                }
            });
            // SAFETY: the reference made above; the operation took its own.
            unsafe { (api.area_unref)(array) };
            image = flattened?;
        }

        // Greyscale, before the resize, as sharp does it.
        image = self.int_operation(&image, api.colourspace, enums.b_w)?;

        let should_resize = hshrink != 1.0 || vshrink != 1.0;
        let premultiply = image.has_alpha() && should_resize;
        let premultiply_format = image.format();
        if premultiply {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_premultiply` with no options.
                unsafe { (api.premultiply)(input, out, ptr::null::<c_char>()) }
            })?;
            image = self.int_operation(&image, api.cast, premultiply_format)?;
        }
        if should_resize {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_resize` with sharp's options, NULL-terminated.
                unsafe {
                    (api.resize)(
                        input,
                        out,
                        1.0 / hshrink,
                        c"vscale".as_ptr(),
                        1.0 / vshrink,
                        c"kernel".as_ptr(),
                        enums.kernel_lanczos3,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }

        // StaySequential: a turn reads out of order, so the pixels are made in memory first.
        // SAFETY: a live image.
        if rotation != enums.angle_d0 && unsafe { (api.is_sequential)(image.ptr()) } != 0 {
            // SAFETY: a live image; the result is a new reference or NULL.
            let in_memory = unsafe { (api.copy_memory)(image.ptr()) };
            image = self.own(in_memory, "Could not hold the image in memory")?;
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_copy` with no options.
                unsafe { (api.copy)(input, out, ptr::null::<c_char>()) }
            })?;
            // SAFETY: a live image this alone holds.
            unsafe { (api.remove)(image.ptr(), c"vips-sequential".as_ptr()) };
        }
        if rotation != enums.angle_d0 {
            image = self.int_operation(&image, api.rot, rotation)?;
        }
        if flop {
            image = self.int_operation(&image, api.flip, enums.direction_horizontal)?;
        }

        if premultiply {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_unpremultiply` with no options.
                unsafe { (api.unpremultiply)(input, out, ptr::null::<c_char>()) }
            })?;
            image = self.int_operation(&image, api.cast, premultiply_format)?;
        }

        // The output colour space, sRGB by default, then the first band of a grey image.
        if self.is_16_bit(image.interpretation()) {
            image = self.int_operation(&image, api.cast, enums.format_ushort)?;
        }
        let interpretation = image.interpretation();
        if interpretation != enums.srgb {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_colourspace` with sharp's options, NULL-terminated.
                unsafe {
                    (api.colourspace)(
                        input,
                        out,
                        enums.srgb,
                        c"source_space".as_ptr(),
                        interpretation,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }
        image = self.int_operation(&image, api.extract_band, 0)?;
        if image.format() != enums.format_uchar {
            image = self.int_operation(&image, api.cast, enums.format_uchar)?;
        }

        let pixels = self.write_to_memory(&image)?;
        let expected = usize::try_from(size).unwrap_or(0).pow(2);
        if pixels.len() != expected {
            return Err(VipsError(format!(
                "Expected {expected} grey bytes, got {}.",
                pixels.len()
            )));
        }
        Ok(pixels)
    }

    /// A still as 8-bit sRGB RGBA, rows top to bottom, the way glazier-core's
    /// `encodeStillToAvif` decodes it for the archive's AVIF encoder:
    ///
    /// ```text
    /// sharp(path, { failOn: "none", limitInputPixels: false })
    ///   .rotate().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" })
    /// ```
    ///
    /// In sharp's pipeline order: the first page, an embedded ICC profile (or CMYK) to sRGB, the
    /// EXIF turn and mirror, an alpha band if there is none, the 16-bit cast and the conversion
    /// to sRGB, then 8 bits. Returns the width, the height and the samples.
    fn rgba_pixels(&self, path: &Path) -> Result<(u32, u32, Vec<u8>)> {
        let file = file_name(path)?;
        let api = &self.api;
        let enums = &api.enums;
        let (mut image, _) = self.open_input(&file, -1)?;
        let (rotation, flop) = exif_rotation(enums, image.int_field(c"orientation"));

        let interpretation = image.interpretation();
        let processing_profile = if interpretation == enums.rgb16 {
            c"p3"
        } else {
            c"srgb"
        };
        let has_profile = image.type_of(c"icc-profile-data") == api.blob_type;
        if has_profile && interpretation != enums.labs && interpretation != enums.grey16 {
            let depth: c_int = if self.is_16_bit(interpretation) {
                16
            } else {
                8
            };
            let transformed = self.apply(&image, |input, out| {
                // SAFETY: `vips_icc_transform` with sharp's options, NULL-terminated.
                unsafe {
                    (api.icc_transform)(
                        input,
                        out,
                        processing_profile.as_ptr(),
                        c"embedded".as_ptr(),
                        1 as c_int,
                        c"depth".as_ptr(),
                        depth,
                        c"intent".as_ptr(),
                        enums.intent_perceptual,
                        ptr::null::<c_char>(),
                    )
                }
            });
            // sharp warns "Invalid embedded profile" and carries on with the pixels as they are.
            if let Ok(transformed) = transformed {
                image = transformed;
            }
        } else if interpretation == enums.cmyk {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_icc_transform` with sharp's options, NULL-terminated.
                unsafe {
                    (api.icc_transform)(
                        input,
                        out,
                        processing_profile.as_ptr(),
                        c"input_profile".as_ptr(),
                        c"cmyk".as_ptr(),
                        c"intent".as_ptr(),
                        enums.intent_perceptual,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }

        // StaySequential: a turn reads out of order, so the pixels are made in memory first.
        // SAFETY: a live image.
        if rotation != enums.angle_d0 && unsafe { (api.is_sequential)(image.ptr()) } != 0 {
            // SAFETY: a live image; the result is a new reference or NULL.
            let in_memory = unsafe { (api.copy_memory)(image.ptr()) };
            image = self.own(in_memory, "Could not hold the image in memory")?;
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_copy` with no options.
                unsafe { (api.copy)(input, out, ptr::null::<c_char>()) }
            })?;
            // SAFETY: a live image this alone holds.
            unsafe { (api.remove)(image.ptr(), c"vips-sequential".as_ptr()) };
        }
        if rotation != enums.angle_d0 {
            image = self.int_operation(&image, api.rot, rotation)?;
        }
        if flop {
            image = self.int_operation(&image, api.flip, enums.direction_horizontal)?;
        }

        // EnsureAlpha(image, 1): an opaque band at the interpretation's full alpha.
        if !image.has_alpha() {
            // SAFETY: plain call.
            let opaque = unsafe { (api.max_alpha)(image.interpretation()) };
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_bandjoin_const1` with no options.
                unsafe { (api.bandjoin_const1)(input, out, opaque, ptr::null::<c_char>()) }
            })?;
        }

        // The output colour space, then 8 bits for `raw({ depth: "uchar" })`.
        if self.is_16_bit(image.interpretation()) {
            image = self.int_operation(&image, api.cast, enums.format_ushort)?;
        }
        let interpretation = image.interpretation();
        if interpretation != enums.srgb {
            image = self.apply(&image, |input, out| {
                // SAFETY: `vips_colourspace` with sharp's options, NULL-terminated.
                unsafe {
                    (api.colourspace)(
                        input,
                        out,
                        enums.srgb,
                        c"source_space".as_ptr(),
                        interpretation,
                        ptr::null::<c_char>(),
                    )
                }
            })?;
        }
        if image.format() != enums.format_uchar {
            image = self.int_operation(&image, api.cast, enums.format_uchar)?;
        }

        let (width, height, bands) = (image.width(), image.height(), image.bands());
        if bands != 4 {
            return Err(VipsError(format!(
                "Expected RGBA, got {bands} bands after the conversion."
            )));
        }
        let pixels = self.write_to_memory(&image)?;
        let expected = (width.unsigned_abs() as usize) * (height.unsigned_abs() as usize) * 4;
        if pixels.len() != expected {
            return Err(VipsError(format!(
                "Expected {expected} RGBA bytes, got {}.",
                pixels.len()
            )));
        }
        Ok((width.unsigned_abs(), height.unsigned_abs(), pixels))
    }

    /// Reads an image's header without decoding its pixels, as glazier-core's `probeImage` does
    /// through sharp's `metadata()`, which opens the file as the pipeline does.
    fn probe(&self, path: &Path) -> Result<ImageProbe> {
        let file = file_name(path)?;
        let (image, _) = self.open_input(&file, -1)?;
        let (width, height) = (image.width(), image.height());
        if width <= 0 || height <= 0 {
            return Err(VipsError("The image has no dimensions.".into()));
        }
        // EXIF orientations 5–8 turn a quarter, so the stored width is the displayed height.
        let quarter_turn = matches!(image.int_field(c"orientation"), Some(5..=8));
        let page_height = image.int_field(c"page-height").unwrap_or(height);
        let (width, height) = if quarter_turn {
            (page_height, width)
        } else {
            (width, page_height)
        };
        let frames = image
            .int_field(c"n-pages")
            .map_or(1, |pages| pages.max(1))
            .unsigned_abs();
        let mut delays_ms = Vec::new();
        if frames > 1 && image.type_of(c"delay") == self.api.array_int_type {
            let mut values: *mut c_int = ptr::null_mut();
            let mut count: c_int = 0;
            // SAFETY: a live image; libvips points `values` into the image's own array.
            let failed = unsafe {
                (self.api.get_array_int)(image.ptr(), c"delay".as_ptr(), &mut values, &mut count)
            } != 0;
            if failed {
                return Err(self.api.take_error("Could not read the frame delays"));
            }
            if !values.is_null() && count > 0 {
                // SAFETY: `count` ints at `values`, alive as long as `image`.
                delays_ms = unsafe { slice::from_raw_parts(values, count.unsigned_abs() as usize) }
                    .to_vec();
            }
        }
        Ok(ImageProbe {
            width: width.unsigned_abs(),
            height: height.unsigned_abs(),
            frames,
            has_alpha: image.has_alpha(),
            frame_delays_ms: delays_ms,
        })
    }

    /// sharp's `OpenInput` for a file: the loader libvips picks, with sharp's options, reopened
    /// at the primary image of a multi-image HEIF. `page` is -1 when none was asked for.
    fn open_input(&self, file: &CStr, page: c_int) -> Result<(Image<'_>, ImageType)> {
        let api = &self.api;
        let enums = &api.enums;
        // SAFETY: a NUL-terminated name; the result is libvips' static class name or NULL.
        let loader = unsafe { (api.find_load)(file.as_ptr()) };
        if loader.is_null() {
            return Err(api.take_error("Input file contains unsupported image format"));
        }
        // SAFETY: a NUL-terminated static string.
        let loader = unsafe { CStr::from_ptr(loader) }.to_string_lossy();
        let image_type = ImageType::of_loader(&loader).ok_or_else(|| {
            VipsError(format!(
                "Input file contains unsupported image format ({loader})"
            ))
        })?;

        let open = |page: c_int| {
            let raw = if image_type.supports_page() {
                // SAFETY: `vips_image_new_from_file` with sharp's options, NULL-terminated.
                unsafe {
                    (api.new_from_file)(
                        file.as_ptr(),
                        c"access".as_ptr(),
                        enums.access_sequential,
                        c"fail_on".as_ptr(),
                        enums.fail_on_none,
                        c"n".as_ptr(),
                        1 as c_int,
                        c"page".as_ptr(),
                        page.max(0),
                        ptr::null::<c_char>(),
                    )
                }
            } else {
                // SAFETY: as above, for a loader without pages.
                unsafe {
                    (api.new_from_file)(
                        file.as_ptr(),
                        c"access".as_ptr(),
                        enums.access_sequential,
                        c"fail_on".as_ptr(),
                        enums.fail_on_none,
                        ptr::null::<c_char>(),
                    )
                }
            };
            self.own(raw, "Input file has corrupt header")
        };

        let mut image = open(page)?;
        if image_type == ImageType::Heif && page == -1 {
            // HeifPrimaryPageReopen.
            let pages = image.int_field(c"n-pages").unwrap_or(1);
            if let Some(primary) = image.int_field(c"heif-primary")
                && pages > 1
                && primary != 0
            {
                image = open(primary)?;
            }
        }
        // sharp's default limitInputChannels.
        if image.bands() > 5 {
            return Err(VipsError("Input image exceeds channel limit".into()));
        }
        Ok((image, image_type))
    }

    fn is_16_bit(&self, interpretation: c_int) -> bool {
        interpretation == self.api.enums.rgb16 || interpretation == self.api.enums.grey16
    }

    fn own(&self, raw: *mut RawImage, context: &str) -> Result<Image<'_>> {
        match NonNull::new(raw) {
            Some(raw) => Ok(Image {
                api: &self.api,
                raw,
            }),
            None => Err(self.api.take_error(context)),
        }
    }

    fn load(&self, call: impl FnOnce(*mut *mut RawImage) -> c_int) -> Result<Image<'_>> {
        let mut out = ptr::null_mut();
        if call(&mut out) != 0 {
            return Err(self.api.take_error("Could not reload the image shrunk"));
        }
        self.own(out, "Could not reload the image shrunk")
    }

    fn apply(
        &self,
        input: &Image<'_>,
        call: impl FnOnce(*mut RawImage, *mut *mut RawImage) -> c_int,
    ) -> Result<Image<'_>> {
        let mut out = ptr::null_mut();
        if call(input.ptr(), &mut out) != 0 {
            return Err(self.api.take_error("A libvips operation failed"));
        }
        self.own(out, "A libvips operation returned no image")
    }

    fn int_operation(
        &self,
        input: &Image<'_>,
        operation: IntOperation,
        argument: c_int,
    ) -> Result<Image<'_>> {
        self.apply(input, |input, out| {
            // SAFETY: an operation of this signature, with no options.
            unsafe { operation(input, out, argument, ptr::null::<c_char>()) }
        })
    }

    fn write_to_memory(&self, image: &Image<'_>) -> Result<Vec<u8>> {
        let mut length = 0usize;
        // SAFETY: a live image; the result is a g_malloc'd buffer of `length` bytes, or NULL.
        let data = unsafe { (self.api.write_to_memory)(image.ptr(), &mut length) };
        if data.is_null() {
            return Err(self.api.take_error("Could not decode the image"));
        }
        // SAFETY: `length` bytes at `data`, freed right after the copy.
        let pixels = unsafe { slice::from_raw_parts(data.cast::<u8>(), length) }.to_vec();
        // SAFETY: the buffer libvips handed over.
        unsafe { (self.api.g_free)(data) };
        Ok(pixels)
    }
}

impl Api {
    fn load(library: &Library) -> Result<Api> {
        /// Looks a function up by name. The caller states its signature, which must be libvips'.
        unsafe fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T> {
            let name = format!("{name}\0");
            // SAFETY: the caller's type is the function's C signature.
            unsafe { library.get::<T>(name.as_bytes()) }
                .map(|symbol| *symbol)
                .map_err(|error| VipsError(format!("libvips has no {name}: {error}")))
        }

        // SAFETY: each type below is the C signature of the libvips 8 or GLib function named.
        unsafe {
            let type_of = |getter: unsafe extern "C" fn() -> GType| getter();
            let enum_from_nick: unsafe extern "C" fn(*const c_char, GType, *const c_char) -> c_int =
                symbol(library, "vips_enum_from_nick")?;
            let value = |type_of: unsafe extern "C" fn() -> GType, nick: &CStr| -> Result<c_int> {
                let value = enum_from_nick(c"oriel-rs".as_ptr(), type_of(), nick.as_ptr());
                if value < 0 {
                    Err(VipsError(format!("libvips has no enum value {nick:?}")))
                } else {
                    Ok(value)
                }
            };
            let access: unsafe extern "C" fn() -> GType = symbol(library, "vips_access_get_type")?;
            let fail_on: unsafe extern "C" fn() -> GType =
                symbol(library, "vips_fail_on_get_type")?;
            let kernel: unsafe extern "C" fn() -> GType = symbol(library, "vips_kernel_get_type")?;
            let intent: unsafe extern "C" fn() -> GType = symbol(library, "vips_intent_get_type")?;
            let direction: unsafe extern "C" fn() -> GType =
                symbol(library, "vips_direction_get_type")?;
            let angle: unsafe extern "C" fn() -> GType = symbol(library, "vips_angle_get_type")?;
            let format: unsafe extern "C" fn() -> GType =
                symbol(library, "vips_band_format_get_type")?;
            let space: unsafe extern "C" fn() -> GType =
                symbol(library, "vips_interpretation_get_type")?;
            let enums = Enums {
                access_sequential: value(access, c"sequential")?,
                fail_on_none: value(fail_on, c"none")?,
                kernel_lanczos3: value(kernel, c"lanczos3")?,
                intent_perceptual: value(intent, c"perceptual")?,
                direction_horizontal: value(direction, c"horizontal")?,
                angle_d0: value(angle, c"d0")?,
                angle_d90: value(angle, c"d90")?,
                angle_d180: value(angle, c"d180")?,
                angle_d270: value(angle, c"d270")?,
                format_uchar: value(format, c"uchar")?,
                format_ushort: value(format, c"ushort")?,
                b_w: value(space, c"b-w")?,
                srgb: value(space, c"srgb")?,
                rgb16: value(space, c"rgb16")?,
                grey16: value(space, c"grey16")?,
                labs: value(space, c"labs")?,
                cmyk: value(space, c"cmyk")?,
            };

            Ok(Api {
                error_buffer: symbol(library, "vips_error_buffer")?,
                error_clear: symbol(library, "vips_error_clear")?,
                object_unref: symbol(library, "g_object_unref")?,
                g_free: symbol(library, "g_free")?,
                version: symbol(library, "vips_version")?,
                find_load: symbol(library, "vips_foreign_find_load")?,
                new_from_file: symbol(library, "vips_image_new_from_file")?,
                jpegload: symbol(library, "vips_jpegload")?,
                webpload: symbol(library, "vips_webpload")?,
                get_typeof: symbol(library, "vips_image_get_typeof")?,
                get_int: symbol(library, "vips_image_get_int")?,
                get_array_int: symbol(library, "vips_image_get_array_int")?,
                remove: symbol(library, "vips_image_remove")?,
                width: symbol(library, "vips_image_get_width")?,
                height: symbol(library, "vips_image_get_height")?,
                bands: symbol(library, "vips_image_get_bands")?,
                format: symbol(library, "vips_image_get_format")?,
                interpretation: symbol(library, "vips_image_get_interpretation")?,
                has_alpha: symbol(library, "vips_image_hasalpha")?,
                page_height: symbol(library, "vips_image_get_page_height")?,
                is_sequential: symbol(library, "vips_image_is_sequential")?,
                copy_memory: symbol(library, "vips_image_copy_memory")?,
                write_to_memory: symbol(library, "vips_image_write_to_memory")?,
                blob_type: type_of(symbol(library, "vips_blob_get_type")?),
                array_int_type: type_of(symbol(library, "vips_array_int_get_type")?),
                array_double_new: symbol(library, "vips_array_double_new")?,
                area_unref: symbol(library, "vips_area_unref")?,
                copy: symbol(library, "vips_copy")?,
                flatten: symbol(library, "vips_flatten")?,
                premultiply: symbol(library, "vips_premultiply")?,
                unpremultiply: symbol(library, "vips_unpremultiply")?,
                icc_transform: symbol(library, "vips_icc_transform")?,
                resize: symbol(library, "vips_resize")?,
                colourspace: symbol(library, "vips_colourspace")?,
                rot: symbol(library, "vips_rot")?,
                flip: symbol(library, "vips_flip")?,
                cast: symbol(library, "vips_cast")?,
                extract_band: symbol(library, "vips_extract_band")?,
                bandjoin_const1: symbol(library, "vips_bandjoin_const1")?,
                max_alpha: symbol(library, "vips_interpretation_max_alpha")?,
                enums,
            })
        }
    }

    /// libvips' last error, or `context` when it left none, and clears it.
    fn take_error(&self, context: &str) -> VipsError {
        // SAFETY: plain calls; the buffer stays valid until it is cleared.
        let message = unsafe {
            let buffer = (self.error_buffer)();
            let message = if buffer.is_null() {
                String::new()
            } else {
                CStr::from_ptr(buffer).to_string_lossy().trim().to_owned()
            };
            (self.error_clear)();
            message
        };
        if message.is_empty() {
            VipsError(context.to_owned())
        } else {
            VipsError(format!("{context}: {message}"))
        }
    }
}

/// A path as libvips takes it: its bytes, which may not hold a NUL.
#[cfg(unix)]
fn file_name(path: &Path) -> Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| VipsError("A path with a NUL byte cannot be opened.".into()))
}

/// A path as libvips takes it on Windows: UTF-8. glazier-core also gives sharp the `\\?\`
/// prefix past 260 characters (`sharpPath`); Phase 8 adds that here.
#[cfg(not(unix))]
fn file_name(path: &Path) -> Result<CString> {
    let text = path
        .to_str()
        .ok_or_else(|| VipsError("A path that is not Unicode cannot be opened.".into()))?;
    CString::new(text).map_err(|_| VipsError("A path with a NUL byte cannot be opened.".into()))
}

/// sharp's `CalculateExifRotationAndFlop`: the clockwise turn, then whether to mirror.
fn exif_rotation(enums: &Enums, orientation: Option<c_int>) -> (c_int, bool) {
    match orientation {
        Some(6) => (enums.angle_d90, false),
        Some(3) => (enums.angle_d180, false),
        Some(8) => (enums.angle_d270, false),
        Some(2) => (enums.angle_d0, true),
        Some(7) => (enums.angle_d270, true),
        Some(4) => (enums.angle_d180, true),
        Some(5) => (enums.angle_d90, true),
        _ => (enums.angle_d0, false),
    }
}

/// sharp's `ResolveShrink` for `fit: "fill"` (ignore the aspect ratio) to `size`×`size`, never
/// shrinking an axis below one pixel.
fn resolve_shrink(width: c_int, height: c_int, size: c_int) -> (f64, f64) {
    let hshrink = f64::from(width) / f64::from(size);
    let vshrink = f64::from(height) / f64::from(size);
    (
        hshrink.min(f64::from(width)),
        vshrink.min(f64::from(height)),
    )
}

/// Names a libvips dylib to load instead of the vendored or installed one.
pub const LIBVIPS_VARIABLE: &str = "ORIEL_RS_LIBVIPS";

/// Fingerprints match glazier-core's only through sharp's libvips line: 8.18, any patch release
/// (the owner's decision of 2026-10-29). 8.17 already prints CMYK differently.
pub fn accepts_libvips_version(version: &str) -> bool {
    version.starts_with("8.18.")
}

/// Where the libvips that loaded came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibvipsSource {
    /// `Contents/Frameworks` of the app bundle this runs from.
    Bundle,
    /// The file [`LIBVIPS_VARIABLE`] names.
    Override,
    /// sharp's prebuilt libvips vendored at `apps/oriel-rs/.vendor/libvips/current/lib`.
    Vendored,
    /// The libvips sharp installed under the repository's `node_modules`.
    NodeModules,
}

impl fmt::Display for LibvipsSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Bundle => "the app bundle",
            Self::Override => LIBVIPS_VARIABLE,
            Self::Vendored => "the vendored copy",
            Self::NodeModules => "node_modules",
        })
    }
}

/// What [`choose_libvips`] looks at, so tests can stand in for the process's own.
struct LibvipsPlaces {
    executable: Option<PathBuf>,
    override_file: Option<std::ffi::OsString>,
    vendored: PathBuf,
    node_store: PathBuf,
}

/// The libvips to load, first found wins:
///
/// 1. `Contents/Frameworks/libvips-cpp.*.dylib` in the app bundle this runs from;
/// 2. the file [`LIBVIPS_VARIABLE`] names;
/// 3. the vendored copy of sharp's prebuilt libvips, `apps/oriel-rs/.vendor/libvips/current/lib`,
///    laid out as the npm `@img/sharp-libvips-darwin-arm64` package's `lib/`;
/// 4. the copy sharp installed under the repository's `node_modules`.
///
/// A bundled app looks only in its bundle, so it never loads a development copy.
pub fn locate_libvips() -> std::result::Result<(PathBuf, LibvipsSource), String> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/core-tidy sits two folders under the workspace")
        .to_path_buf();
    choose_libvips(&LibvipsPlaces {
        executable: std::env::current_exe().ok(),
        override_file: std::env::var_os(LIBVIPS_VARIABLE).filter(|value| !value.is_empty()),
        vendored: workspace.join(".vendor/libvips/current/lib"),
        node_store: workspace.join("../../node_modules/.pnpm"),
    })
}

fn choose_libvips(places: &LibvipsPlaces) -> std::result::Result<(PathBuf, LibvipsSource), String> {
    let contents = places.executable.as_deref().and_then(|executable| {
        let macos = executable.parent()?;
        let contents = macos.parent()?;
        (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents").then_some(contents)
    });
    if let Some(contents) = contents {
        let frameworks = contents.join("Frameworks");
        return libvips_in(&frameworks)
            .map(|found| (found, LibvipsSource::Bundle))
            .ok_or_else(|| {
                format!(
                    "no libvips in {}; the app was packaged without it",
                    frameworks.display()
                )
            });
    }
    if let Some(file) = &places.override_file {
        return Ok((PathBuf::from(file), LibvipsSource::Override));
    }
    if let Some(found) = libvips_in(&places.vendored) {
        return Ok((found, LibvipsSource::Vendored));
    }
    if let Some(found) = node_modules_libvips(&places.node_store) {
        return Ok((found, LibvipsSource::NodeModules));
    }
    Err(format!(
        "no libvips: vendor sharp's prebuilt libvips into {}, run `pnpm install` at the \
         repository root, or set {LIBVIPS_VARIABLE} to a libvips dylib",
        places.vendored.display()
    ))
}

/// sharp's `libvips-cpp.<version>.dylib` in `folder`, the newest name first.
fn libvips_in(folder: &Path) -> Option<PathBuf> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("libvips-cpp.") && name.ends_with(".dylib"))
        .collect();
    names.sort();
    names
        .into_iter()
        .rev()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
}

/// The libvips in pnpm's store, under `@img+sharp-libvips-darwin-arm64@<version>`.
fn node_modules_libvips(store: &Path) -> Option<PathBuf> {
    let package = "sharp-libvips-darwin-arm64";
    let mut folders: Vec<PathBuf> = std::fs::read_dir(store)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            name.starts_with(&format!("@img+{package}@")).then(|| {
                entry
                    .path()
                    .join("node_modules/@img")
                    .join(package)
                    .join("lib")
            })
        })
        .collect();
    folders.sort();
    folders.iter().rev().find_map(|folder| libvips_in(folder))
}

impl Vips {
    /// Finds libvips (see [`locate_libvips`]), loads it, and refuses a build outside sharp's
    /// 8.18 line, whose fingerprints would not be glazier-core's.
    pub fn open_located() -> Result<(Vips, PathBuf, LibvipsSource)> {
        let (path, source) = locate_libvips().map_err(VipsError)?;
        let vips = Vips::open(&path)?;
        let version = vips.version();
        if !accepts_libvips_version(&version) {
            return Err(VipsError(format!(
                "libvips {version} from {source} ({}) is not 8.18.x, so its fingerprints would \
                 not be glazier-core's",
                path.display()
            )));
        }
        log::info!(
            "libvips {version} loaded from {} ({source})",
            path.display()
        );
        Ok((vips, path, source))
    }

    /// Finds libvips as [`Vips::open_located`] does, to load on first use: a dylib whose name
    /// gives a version outside sharp's 8.18 line is refused now, any other once it is loaded.
    pub fn locate_deferred() -> Result<(Vips, PathBuf, LibvipsSource)> {
        let (path, source) = locate_libvips().map_err(VipsError)?;
        let named = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix("libvips-cpp.")?.strip_suffix(".dylib"))
            .filter(|version| version.split('.').all(|part| part.parse::<u32>().is_ok()));
        if let Some(version) = named
            && !accepts_libvips_version(version)
        {
            return Err(VipsError(format!(
                "libvips {version} from {source} ({}) is not 8.18.x, so its fingerprints would \
                 not be glazier-core's",
                path.display()
            )));
        }
        Ok((Vips::deferred(&path), path, source))
    }
}

#[cfg(test)]
mod locate_tests {
    use super::*;

    fn places(root: &Path) -> LibvipsPlaces {
        LibvipsPlaces {
            executable: None,
            override_file: None,
            vendored: root.join("vendor/lib"),
            node_store: root.join("store"),
        }
    }

    fn put(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn libvips_is_found_in_the_bundle_then_the_variable_then_vendored_then_node_modules() {
        let root =
            std::env::temp_dir().join(format!("oriel-libvips-places-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut places = places(&root);
        assert!(choose_libvips(&places).is_err());

        let store = root.join(
            "store/@img+sharp-libvips-darwin-arm64@1.3.4/node_modules/@img/\
             sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib",
        );
        put(&store);
        assert_eq!(
            choose_libvips(&places).unwrap(),
            (store.clone(), LibvipsSource::NodeModules)
        );

        let vendored = root.join("vendor/lib/libvips-cpp.8.18.8.dylib");
        put(&vendored);
        assert_eq!(
            choose_libvips(&places).unwrap(),
            (vendored, LibvipsSource::Vendored)
        );

        places.override_file = Some("/somewhere/libvips-cpp.dylib".into());
        assert_eq!(choose_libvips(&places).unwrap().1, LibvipsSource::Override);

        // A bundle looks only inside itself, so a bundle packed without libvips says so.
        places.executable = Some(root.join("Oriel RS.app/Contents/MacOS/oriel-rs"));
        assert!(choose_libvips(&places).is_err());
        let bundled = root.join("Oriel RS.app/Contents/Frameworks/libvips-cpp.8.18.7.dylib");
        put(&bundled);
        assert_eq!(
            choose_libvips(&places).unwrap(),
            (bundled, LibvipsSource::Bundle)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn any_8_18_release_is_accepted() {
        assert!(accepts_libvips_version("8.18.7"));
        assert!(accepts_libvips_version("8.18.0"));
        assert!(!accepts_libvips_version("8.17.3"));
        assert!(!accepts_libvips_version("8.19.0"));
        assert!(!accepts_libvips_version("8.180.1"));
    }
}
