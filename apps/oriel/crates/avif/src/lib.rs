//! Stills to AVIF through libavif with aom, at `media-format`'s archive settings, for Tidy's
//! Convert (plan 063, Phase 6).
//!
//! Electron Oriel encodes with jSquash's wasm build of libavif (`@jsquash/avif`), whose
//! `avif_enc.cpp` turns each option into libavif calls. [`Libavif::encode`] makes the same calls
//! in the same order on a native libavif: the same pixel format, matrix, chroma downsampling,
//! quality and aom options, so a file differs from the wasm encoder's only by the libavif and aom
//! releases and the thread count.
//!
//! What it takes is what glazier-core's `encodeStillToAvif` hands the wasm encoder: pixels with
//! EXIF orientation already applied, converted to sRGB (from an embedded ICC profile, or CMYK),
//! 8-bit, interleaved. Like jSquash it writes no ICC profile, no EXIF and no rotation or mirror
//! box: the file's `colr` box says unspecified primaries and transfer with the BT.601 matrix,
//! full range, which every decoder reads as sRGB. The decode that gets there is sharp's
//! `.rotate().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" })`, which the libvips
//! binding in `oriel-core-tidy` can repeat exactly, since it loads the same libvips build.
//!
//! libavif is BSD-licensed, but it is loaded at run time as libvips and libmpv are, so a build
//! needs no C toolchain and the app carries one copy of it. [`Libavif::get`] looks in this order,
//! first found wins:
//!
//! 1. `Contents/Frameworks/libavif.16.dylib` of the app bundle this runs from (on Windows, one of
//!    [`LIBAVIF_WINDOWS_FILES`] in the `libavif` folder beside the executable, where `package
//!    windows` stages MSYS2's build with the DLLs it needs, or beside the executable itself);
//! 2. the file `ORIEL_LIBAVIF` names;
//! 3. the vendored set, `apps/oriel/.vendor/libavif/current` (`cargo run -p xtask -- vendor`),
//!    or on Windows `apps/oriel/.vendor/libavif-windows` (`vendor libavif-windows`).
//!
//! On Windows a libavif loads with its own folder searched first for the DLLs it needs (aom,
//! dav1d, rav1e, SVT-AV1, libyuv and MinGW's runtime), so they need not sit beside the executable.

mod ffi;

use std::ffi::{CStr, CString, OsString, c_int};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;
pub use oriel_core_format::{ARCHIVE_AVIF_OPTIONS, AvifEncodeOptions, encode_archive_avif};

use ffi::{Api, EncoderHead, RgbImageSlot, RwData};

/// Names a libavif to load when the app does not carry one.
pub const LIBAVIF_VARIABLE: &str = "ORIEL_LIBAVIF";

/// libavif 1.x's file name, the one the vendored set and the bundle carry.
pub const LIBAVIF_FILE: &str = "libavif.16.dylib";

/// libavif 1.x's names on Windows, beside the installed app: CMake's MSVC build makes
/// `avif.dll`, MinGW's (MSYS2's package) `libavif-16.dll`.
pub const LIBAVIF_WINDOWS_FILES: [&str; 2] = ["avif.dll", "libavif-16.dll"];

/// The folder beside the executable the Windows package stages libavif and its DLLs in.
pub const LIBAVIF_WINDOWS_FOLDER: &str = "libavif";

/// What went wrong, in words for a log or a journal entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvifError(pub String);

impl fmt::Display for AvifError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AvifError {}

pub type Result<T> = std::result::Result<T, AvifError>;

/// How a still's samples are interleaved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channels {
    Rgb,
    Rgba,
}

impl Channels {
    fn count(self) -> usize {
        match self {
            Self::Rgb => 3,
            Self::Rgba => 4,
        }
    }
}

/// A still's samples: 8-bit for an 8-bit AVIF, 16-bit words holding 10 or 12 bits for a deeper
/// one, as jSquash takes them.
#[derive(Clone, Copy, Debug)]
pub enum Samples<'a> {
    Eight(&'a [u8]),
    Sixteen(&'a [u16]),
}

/// Interleaved sRGB pixels, rows top to bottom with no padding, orientation already applied.
#[derive(Clone, Copy, Debug)]
pub struct Still<'a> {
    pub width: u32,
    pub height: u32,
    pub channels: Channels,
    pub samples: Samples<'a>,
}

/// Where the libavif that loaded came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LibavifSource {
    /// `Contents/Frameworks` of the app bundle this runs from.
    Bundle,
    /// The file [`LIBAVIF_VARIABLE`] names.
    Override,
    /// The development set in `apps/oriel/.vendor/libavif/current`.
    Vendored,
}

impl fmt::Display for LibavifSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Bundle => "the app bundle's libavif",
            Self::Override => LIBAVIF_VARIABLE,
            Self::Vendored => "the vendored libavif",
        })
    }
}

/// What [`choose`] looks at, so tests can stand in for the process's own.
struct Places {
    executable: Option<PathBuf>,
    override_file: Option<OsString>,
    vendored: PathBuf,
}

impl Places {
    fn of_this_process() -> Self {
        Self {
            executable: std::env::current_exe().ok(),
            override_file: std::env::var_os(LIBAVIF_VARIABLE).filter(|value| !value.is_empty()),
            vendored: vendored_set(),
        }
    }
}

/// `apps/oriel/.vendor/libavif/current`, found from this crate's folder at compile time, as
/// `oriel-tools` finds its development cache.
fn vendored_set() -> PathBuf {
    let vendor = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/avif sits two folders under the workspace")
        .join(".vendor");
    if cfg!(windows) {
        vendor.join("libavif-windows")
    } else {
        vendor.join("libavif").join("current")
    }
}

/// The vendored set's entry library on this system.
fn vendored_file() -> &'static str {
    if cfg!(windows) {
        LIBAVIF_WINDOWS_FILES[1]
    } else {
        LIBAVIF_FILE
    }
}

/// `X.app/Contents` when `executable` is `X.app/Contents/MacOS/<name>`.
fn bundle_contents(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents").then_some(contents)
}

/// The libavif to load, first match wins: the bundle's, the override, the vendored set. Once one
/// is chosen, failing to load it is an error rather than a fall through, so a broken copy shows.
fn choose(places: &Places) -> std::result::Result<(PathBuf, LibavifSource), String> {
    #[cfg(windows)]
    if let Some(folder) = places.executable.as_deref().and_then(Path::parent)
        && let Some(found) = [folder.join(LIBAVIF_WINDOWS_FOLDER), folder.to_path_buf()]
            .iter()
            .flat_map(|folder| LIBAVIF_WINDOWS_FILES.map(|name| folder.join(name)))
            .find(|path| path.is_file())
    {
        return Ok((found, LibavifSource::Bundle));
    }
    if let Some(contents) = places.executable.as_deref().and_then(bundle_contents) {
        let bundled = contents.join("Frameworks").join(LIBAVIF_FILE);
        if bundled.is_file() {
            return Ok((bundled, LibavifSource::Bundle));
        }
    }
    if let Some(file) = &places.override_file {
        return Ok((PathBuf::from(file), LibavifSource::Override));
    }
    let vendored = places.vendored.join(vendored_file());
    if vendored.is_file() {
        return Ok((vendored, LibavifSource::Vendored));
    }
    if cfg!(windows) {
        return Err(format!(
            "no libavif: fetch it with `cargo run -p xtask -- vendor libavif-windows` in \
             apps/oriel, or set {LIBAVIF_VARIABLE} to one"
        ));
    }
    Err(format!(
        "no libavif: fetch it with `pnpm --filter @latch-works/oriel vendor` (or `cargo run \
         -p xtask -- vendor libavif` in apps/oriel), or set {LIBAVIF_VARIABLE} to one"
    ))
}

/// Loads a library.
///
/// # Safety
///
/// Loading runs the library's initialisers, as [`Library::new`] does.
#[cfg(not(windows))]
unsafe fn open_library(path: &Path) -> std::result::Result<Library, libloading::Error> {
    // SAFETY: the caller's.
    unsafe { Library::new(path) }
}

/// Loads a library with its own folder searched first for the DLLs it needs, as
/// `LOAD_WITH_ALTERED_SEARCH_PATH` does for an absolute path: MSYS2's libavif needs a dozen,
/// which sit beside it rather than beside the executable.
///
/// # Safety
///
/// Loading runs the library's initialisers, as [`Library::new`] does.
#[cfg(windows)]
unsafe fn open_library(path: &Path) -> std::result::Result<Library, libloading::Error> {
    use libloading::os::windows::{LOAD_WITH_ALTERED_SEARCH_PATH, Library as WindowsLibrary};
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    // SAFETY: the caller's.
    unsafe { WindowsLibrary::load_with_flags(&absolute, LOAD_WITH_ALTERED_SEARCH_PATH) }
        .map(Library::from)
}

static LIBAVIF: OnceLock<std::result::Result<Libavif, String>> = OnceLock::new();

/// A loaded libavif. Encoders are made per call, so one `Libavif` serves every thread.
pub struct Libavif {
    api: Api,
    path: PathBuf,
    source: LibavifSource,
    version: String,
    _library: Library,
}

impl fmt::Debug for Libavif {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Libavif")
            .field("path", &self.path)
            .field("source", &self.source)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl Libavif {
    /// The process's libavif, found by the search order above and loaded on first use.
    pub fn get() -> Result<&'static Libavif> {
        LIBAVIF
            .get_or_init(|| {
                let (path, source) = choose(&Places::of_this_process())?;
                Self::load(&path, source)
            })
            .as_ref()
            .map_err(|error| AvifError(error.clone()))
    }

    /// Loads libavif from `path`, outside the search order: for tests and measurements.
    pub fn open(path: &Path) -> Result<Libavif> {
        Self::load(path, LibavifSource::Override).map_err(AvifError)
    }

    fn load(path: &Path, source: LibavifSource) -> std::result::Result<Libavif, String> {
        // SAFETY: loading libavif runs its initialisers (and aom's and dav1d's), which have no
        // preconditions.
        let library = unsafe { open_library(path) }
            .map_err(|error| format!("could not load {}: {error}", path.display()))?;
        let api = Api::load(&library, path)?;
        Ok(Libavif {
            version: api.version_string(),
            api,
            path: path.to_path_buf(),
            source,
            _library: library,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn source(&self) -> LibavifSource {
        self.source
    }

    /// libavif's version, such as `1.4.2`.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// The codecs libavif was built with and their versions.
    pub fn codec_versions(&self) -> String {
        self.api.codec_versions_string()
    }

    /// Encodes `still` with `options` as jSquash's `avif_enc.cpp` does, on up to `threads`
    /// threads (the wasm build Tidy uses runs on one). aom's output depends on the thread
    /// count, so a fixed count gives the same bytes every time.
    pub fn encode(
        &self,
        still: &Still<'_>,
        options: &AvifEncodeOptions,
        threads: u32,
    ) -> Result<Vec<u8>> {
        let depth = options.bit_depth;
        if !matches!(depth, 8 | 10 | 12) {
            return Err(AvifError(
                "Invalid bit depth. Supported values are 8, 10, or 12.".into(),
            ));
        }
        let format = match options.subsample {
            0 => ffi::AVIF_PIXEL_FORMAT_YUV400,
            1 => ffi::AVIF_PIXEL_FORMAT_YUV420,
            2 => ffi::AVIF_PIXEL_FORMAT_YUV422,
            3 => ffi::AVIF_PIXEL_FORMAT_YUV444,
            other => return Err(AvifError(format!("No such subsampling: {other}."))),
        };
        let (pixels, bytes_per_sample) = check_still(still, depth)?;
        let row_bytes =
            u32::try_from(still.width as usize * still.channels.count() * bytes_per_sample)
                .map_err(|_| AvifError("Too wide a still.".into()))?;

        let lossless = options.quality == ffi::AVIF_QUALITY_LOSSLESS
            && (options.quality_alpha == -1 || options.quality_alpha == ffi::AVIF_QUALITY_LOSSLESS)
            && format == ffi::AVIF_PIXEL_FORMAT_YUV444;

        let api = &self.api;
        // SAFETY: plain call; the image is destroyed by the guard.
        let image = unsafe { (api.image_create)(still.width, still.height, depth as u32, format) };
        if image.is_null() {
            return Err(AvifError("libavif could not make the image.".into()));
        }
        let image = Owned {
            pointer: image,
            destroy: api.image_destroy,
        };
        // SAFETY: `image` is a live avifImage, whose start `ImageHead` lays out.
        unsafe {
            (*image.pointer).matrix_coefficients = if lossless {
                ffi::AVIF_MATRIX_COEFFICIENTS_IDENTITY
            } else {
                ffi::AVIF_MATRIX_COEFFICIENTS_BT601
            };
        }

        let mut rgb = RgbImageSlot::zeroed();
        // SAFETY: `rgb` is a zeroed avifRGBImage with room to spare; `image` is live.
        unsafe { (api.rgb_image_set_defaults)(&mut rgb.image, image.pointer) };
        // libavif only reads the pixels when converting from RGB.
        rgb.image.pixels = pixels.cast_mut();
        rgb.image.format = match still.channels {
            Channels::Rgb => ffi::AVIF_RGB_FORMAT_RGB,
            Channels::Rgba => ffi::AVIF_RGB_FORMAT_RGBA,
        };
        rgb.image.depth = depth as u32;
        rgb.image.row_bytes = row_bytes;
        if options.enable_sharp_yuv {
            rgb.image.chroma_downsampling = ffi::AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV;
        }
        // SAFETY: `rgb.pixels` points at width × height × channels samples of `depth` bits,
        // checked by `check_still`, and outlives the call.
        let status = unsafe { (api.image_rgb_to_yuv)(image.pointer, &rgb.image) };
        if status != ffi::AVIF_RESULT_OK {
            return Err(AvifError(format!(
                "libavif could not convert the pixels to YUV: {}",
                api.describe(status)
            )));
        }

        // SAFETY: plain call; the encoder is destroyed by the guard.
        let encoder = unsafe { (api.encoder_create)() };
        if encoder.is_null() {
            return Err(AvifError("libavif could not make an encoder.".into()));
        }
        let encoder = Owned {
            pointer: encoder,
            destroy: api.encoder_destroy,
        };
        let head = encoder.pointer;

        // SAFETY: `head` is a live avifEncoder, whose start `EncoderHead` lays out; options are
        // NUL-terminated strings libavif copies.
        unsafe {
            if lossless {
                (*head).quality = ffi::AVIF_QUALITY_LOSSLESS;
                (*head).quality_alpha = ffi::AVIF_QUALITY_LOSSLESS;
            } else {
                self.set_option(head, c"sharpness", &options.sharpness.to_string())?;
                (*head).quality = options.quality;
                (*head).quality_alpha = if options.quality_alpha == -1 {
                    options.quality
                } else {
                    options.quality_alpha
                };
                if options.tune == 2 || (options.tune == 0 && options.quality >= 50) {
                    self.set_option(head, c"tune", "ssim")?;
                }
                if options.chroma_delta_q {
                    self.set_option(head, c"color:enable-chroma-deltaq", "1")?;
                }
                self.set_option(
                    head,
                    c"color:denoise-noise-level",
                    &options.denoise_level.to_string(),
                )?;
            }
            // jSquash's build has aom alone, so libavif's automatic choice is aom there; this
            // build also has dav1d, which only decodes, so automatic would be aom too.
            (*head).codec_choice = ffi::AVIF_CODEC_CHOICE_AOM;
            (*head).max_threads = c_int::try_from(threads.max(1)).unwrap_or(c_int::MAX);
            (*head).tile_rows_log2 = options.tile_rows_log2;
            (*head).tile_cols_log2 = options.tile_cols_log2;
            (*head).speed = options.speed;
        }

        let mut output = RwData {
            data: std::ptr::null_mut(),
            size: 0,
        };
        // SAFETY: the encoder and the image are live; `output` starts empty, as libavif needs.
        let status = unsafe { (api.encoder_write)(head, image.pointer, &mut output) };
        let result = if status == ffi::AVIF_RESULT_OK && !output.data.is_null() {
            // SAFETY: on success libavif filled `output` with `size` bytes.
            Ok(unsafe { std::slice::from_raw_parts(output.data, output.size) }.to_vec())
        } else {
            Err(AvifError(format!(
                "libavif could not encode: {}{}",
                api.describe(status),
                // SAFETY: the encoder is live; `diag_error` is a NUL-terminated buffer.
                unsafe { diagnostics(head) }
            )))
        };
        // SAFETY: `output` is libavif's own, freed once.
        unsafe { (api.rw_data_free)(&mut output) };
        result
    }

    /// # Safety
    /// `encoder` must be a live avifEncoder.
    unsafe fn set_option(&self, encoder: *mut EncoderHead, key: &CStr, value: &str) -> Result<()> {
        let value = CString::new(value).map_err(|_| AvifError("Bad option value.".into()))?;
        // SAFETY: the caller's encoder is live; both strings are NUL-terminated.
        let status = unsafe {
            (self.api.encoder_set_codec_specific_option)(encoder, key.as_ptr(), value.as_ptr())
        };
        if status != ffi::AVIF_RESULT_OK {
            return Err(AvifError(format!(
                "libavif refused {}={}: {}",
                key.to_string_lossy(),
                value.to_string_lossy(),
                self.api.describe(status)
            )));
        }
        Ok(())
    }

    /// Encodes `still` at `ARCHIVE_AVIF_OPTIONS`, and once more at the low-memory speed when that
    /// fails, as Electron Oriel's `createArchiveAvifEncoder` does.
    pub fn encode_archive(&self, still: &Still<'_>, threads: u32) -> Result<Vec<u8>> {
        encode_archive_avif(|options| self.encode(still, options, threads))
    }
}

/// The still's sample pointer and bytes per sample, once its buffer is checked against its size
/// and the depth asked for.
fn check_still(still: &Still<'_>, depth: i32) -> Result<(*const u8, usize)> {
    if still.width == 0 || still.height == 0 {
        return Err(AvifError("An empty still.".into()));
    }
    let wanted = (still.width as usize)
        .checked_mul(still.height as usize)
        .and_then(|pixels| pixels.checked_mul(still.channels.count()))
        .ok_or_else(|| AvifError("Too large a still.".into()))?;
    let (pointer, length, bytes) = match (still.samples, depth) {
        (Samples::Eight(samples), 8) => (samples.as_ptr(), samples.len(), 1),
        (Samples::Sixteen(samples), 10 | 12) => (samples.as_ptr().cast::<u8>(), samples.len(), 2),
        (Samples::Eight(_), _) => {
            return Err(AvifError(format!(
                "A {depth}-bit AVIF needs 16-bit samples."
            )));
        }
        (Samples::Sixteen(_), _) => {
            return Err(AvifError("An 8-bit AVIF needs 8-bit samples.".into()));
        }
    };
    if length != wanted {
        return Err(AvifError(format!(
            "{length} samples is not a {}×{} {:?} still.",
            still.width, still.height, still.channels
        )));
    }
    Ok((pointer, bytes))
}

/// libavif's own explanation of an encoder's last error, or nothing.
///
/// # Safety
/// `encoder` must be a live avifEncoder.
unsafe fn diagnostics(encoder: *const EncoderHead) -> String {
    // SAFETY: the caller's encoder is live and libavif keeps `diag.error` NUL-terminated.
    let text = unsafe { CStr::from_ptr((*encoder).diag_error.as_ptr()) }.to_string_lossy();
    if text.is_empty() {
        String::new()
    } else {
        format!(" ({text})")
    }
}

/// A libavif object, destroyed when dropped.
struct Owned<T> {
    pointer: *mut T,
    destroy: unsafe extern "C" fn(*mut T),
}

impl<T> Drop for Owned<T> {
    fn drop(&mut self) {
        // SAFETY: `pointer` came from the matching create function and is destroyed once.
        unsafe { (self.destroy)(self.pointer) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-avif-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn put(file: &Path) -> PathBuf {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, b"").unwrap();
        file.to_path_buf()
    }

    #[test]
    fn a_bundle_loads_its_own_then_the_override_then_the_vendored_set() {
        let root = scratch("choose");
        let contents = root.join("Oriel.app/Contents");
        let executable = contents.join("MacOS/oriel");
        let vendored = root.join(".vendor/libavif/current");
        let places = |executable: &Path, override_file: Option<&str>| Places {
            executable: Some(executable.to_path_buf()),
            override_file: override_file.map(OsString::from),
            vendored: vendored.clone(),
        };

        let error = choose(&places(&executable, None)).unwrap_err();
        assert!(error.contains("vendor"), "{error}");

        let dev = put(&vendored.join(vendored_file()));
        assert_eq!(
            choose(&places(&executable, None)).unwrap(),
            (dev.clone(), LibavifSource::Vendored)
        );
        assert_eq!(
            choose(&places(&executable, Some("/elsewhere/libavif.dylib"))).unwrap(),
            (
                PathBuf::from("/elsewhere/libavif.dylib"),
                LibavifSource::Override
            )
        );

        let bundled = put(&contents.join("Frameworks").join(LIBAVIF_FILE));
        assert_eq!(
            choose(&places(&executable, Some("/elsewhere/libavif.dylib"))).unwrap(),
            (bundled, LibavifSource::Bundle)
        );
        // Outside a bundle the same Frameworks folder is not looked at.
        let loose = root.join("bin/oriel");
        assert_eq!(
            choose(&places(&loose, None)).unwrap(),
            (dev, LibavifSource::Vendored)
        );
    }

    #[test]
    fn a_still_must_fill_its_buffer_at_its_depth() {
        let pixels = [0u8; 4 * 2 * 3];
        let still = Still {
            width: 2,
            height: 3,
            channels: Channels::Rgba,
            samples: Samples::Eight(&pixels),
        };
        assert!(check_still(&still, 8).is_ok());
        assert!(check_still(&still, 10).is_err());
        let short = Still { height: 4, ..still };
        assert!(check_still(&short, 8).is_err());
    }
}
