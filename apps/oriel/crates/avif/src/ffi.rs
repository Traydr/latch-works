//! libavif's C API, as much of it as the encoder needs, loaded from the dylib at run time.
//!
//! libavif has no setters for an encoder's settings or an image's colour, so the fields this
//! crate sets are laid out here. libavif 1.x only ever adds members after a "Version 1.x.0 ends
//! here" marker, so the start of each struct, which is all this reads or writes, is the same in
//! every 1.x release; [`Api::load`] refuses any other major version. `tests/layout.rs` checks the
//! offsets against the vendored set's own `avif.h`.

use std::ffi::{CStr, c_char, c_int};
use std::path::Path;

use libloading::Library;

/// `avifResult`; 0 is `AVIF_RESULT_OK`.
pub type AvifResult = c_int;
pub const AVIF_RESULT_OK: AvifResult = 0;

pub const AVIF_QUALITY_LOSSLESS: c_int = 100;

/// `avifPixelFormat`.
pub const AVIF_PIXEL_FORMAT_YUV444: c_int = 1;
pub const AVIF_PIXEL_FORMAT_YUV422: c_int = 2;
pub const AVIF_PIXEL_FORMAT_YUV420: c_int = 3;
pub const AVIF_PIXEL_FORMAT_YUV400: c_int = 4;

/// `avifMatrixCoefficients` (a `uint16_t`).
pub const AVIF_MATRIX_COEFFICIENTS_IDENTITY: u16 = 0;
pub const AVIF_MATRIX_COEFFICIENTS_BT601: u16 = 6;

/// `avifRGBFormat`.
pub const AVIF_RGB_FORMAT_RGB: c_int = 0;
pub const AVIF_RGB_FORMAT_RGBA: c_int = 1;

/// `avifChromaDownsampling`.
pub const AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV: c_int = 4;

/// `avifCodecChoice` and `avifCodecFlag`.
pub const AVIF_CODEC_CHOICE_AOM: c_int = 1;
pub const AVIF_CODEC_FLAG_CAN_ENCODE: u32 = 1 << 1;

/// `avifRWData`.
#[repr(C)]
pub struct RwData {
    pub data: *mut u8,
    pub size: usize,
}

/// The start of `avifImage`, through `matrixCoefficients`, all in libavif 1.0.0's part of it.
/// libavif allocates the image, so only the start need be known.
#[repr(C)]
pub struct ImageHead {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub yuv_format: c_int,
    pub yuv_range: c_int,
    pub yuv_chroma_sample_position: c_int,
    pub yuv_planes: [*mut u8; 3],
    pub yuv_row_bytes: [u32; 3],
    pub image_owns_yuv_planes: c_int,
    pub alpha_plane: *mut u8,
    pub alpha_row_bytes: u32,
    pub image_owns_alpha_plane: c_int,
    pub alpha_premultiplied: c_int,
    pub icc: RwData,
    pub color_primaries: u16,
    pub transfer_characteristics: u16,
    pub matrix_coefficients: u16,
}

/// `avifRGBImage`, which the caller allocates and `avifRGBImageSetDefaults` fills.
#[repr(C)]
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub format: c_int,
    pub chroma_upsampling: c_int,
    pub chroma_downsampling: c_int,
    pub avoid_lib_yuv: c_int,
    pub ignore_alpha: c_int,
    pub alpha_premultiplied: c_int,
    pub is_float: c_int,
    pub max_threads: c_int,
    pub pixels: *mut u8,
    pub row_bytes: u32,
}

/// [`RgbImage`] with room after it, in case a later libavif grows the struct, so
/// `avifRGBImageSetDefaults` never writes past what was allocated.
#[repr(C)]
pub struct RgbImageSlot {
    pub image: RgbImage,
    _reserve: [u64; 16],
}

impl RgbImageSlot {
    pub fn zeroed() -> Self {
        // SAFETY: every field is an integer or a raw pointer, for which all zeroes is valid;
        // libavif's own docs allow `memset` in place of `avifRGBImageSetDefaults`.
        unsafe { std::mem::zeroed() }
    }
}

/// `avifFraction`.
#[repr(C)]
pub struct Fraction {
    pub n: i32,
    pub d: i32,
}

/// The start of `avifEncoder`, through `diag`, all in libavif 1.0.0's part of it.
#[repr(C)]
pub struct EncoderHead {
    pub codec_choice: c_int,
    pub max_threads: c_int,
    pub speed: c_int,
    pub keyframe_interval: c_int,
    pub timescale: u64,
    pub repetition_count: c_int,
    pub extra_layer_count: u32,
    pub quality: c_int,
    pub quality_alpha: c_int,
    pub min_quantizer: c_int,
    pub max_quantizer: c_int,
    pub min_quantizer_alpha: c_int,
    pub max_quantizer_alpha: c_int,
    pub tile_rows_log2: c_int,
    pub tile_cols_log2: c_int,
    pub auto_tiling: c_int,
    pub scaling_horizontal: Fraction,
    pub scaling_vertical: Fraction,
    pub io_color_obu_size: usize,
    pub io_alpha_obu_size: usize,
    /// `avifDiagnostics.error`: what went wrong, in libavif's words.
    pub diag_error: [c_char; 256],
}

/// The functions the encoder calls, resolved once from the loaded dylib.
pub struct Api {
    pub version: unsafe extern "C" fn() -> *const c_char,
    pub codec_versions: unsafe extern "C" fn(*mut c_char),
    pub codec_name: unsafe extern "C" fn(c_int, u32) -> *const c_char,
    pub result_to_string: unsafe extern "C" fn(AvifResult) -> *const c_char,
    pub image_create: unsafe extern "C" fn(u32, u32, u32, c_int) -> *mut ImageHead,
    pub image_destroy: unsafe extern "C" fn(*mut ImageHead),
    pub rgb_image_set_defaults: unsafe extern "C" fn(*mut RgbImage, *const ImageHead),
    pub image_rgb_to_yuv: unsafe extern "C" fn(*mut ImageHead, *const RgbImage) -> AvifResult,
    pub encoder_create: unsafe extern "C" fn() -> *mut EncoderHead,
    pub encoder_destroy: unsafe extern "C" fn(*mut EncoderHead),
    pub encoder_set_codec_specific_option:
        unsafe extern "C" fn(*mut EncoderHead, *const c_char, *const c_char) -> AvifResult,
    pub encoder_write:
        unsafe extern "C" fn(*mut EncoderHead, *const ImageHead, *mut RwData) -> AvifResult,
    pub rw_data_free: unsafe extern "C" fn(*mut RwData),
}

impl Api {
    /// Resolves every function, and refuses a libavif this layout was not written for or one
    /// without aom's encoder.
    pub fn load(library: &Library, path: &Path) -> Result<Api, String> {
        /// # Safety
        /// `T` must be the C signature of the symbol `name` names.
        unsafe fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T, String> {
            // SAFETY: the caller names the symbol's real signature.
            unsafe { library.get::<T>(name.as_bytes()) }
                .map(|symbol| *symbol)
                .map_err(|error| format!("libavif has no {name}: {error}"))
        }

        // SAFETY: each type below is the function's declaration in libavif 1.x's avif.h.
        let api = unsafe {
            Api {
                version: symbol(library, "avifVersion")?,
                codec_versions: symbol(library, "avifCodecVersions")?,
                codec_name: symbol(library, "avifCodecName")?,
                result_to_string: symbol(library, "avifResultToString")?,
                image_create: symbol(library, "avifImageCreate")?,
                image_destroy: symbol(library, "avifImageDestroy")?,
                rgb_image_set_defaults: symbol(library, "avifRGBImageSetDefaults")?,
                image_rgb_to_yuv: symbol(library, "avifImageRGBToYUV")?,
                encoder_create: symbol(library, "avifEncoderCreate")?,
                encoder_destroy: symbol(library, "avifEncoderDestroy")?,
                encoder_set_codec_specific_option: symbol(
                    library,
                    "avifEncoderSetCodecSpecificOption",
                )?,
                encoder_write: symbol(library, "avifEncoderWrite")?,
                rw_data_free: symbol(library, "avifRWDataFree")?,
            }
        };

        let version = api.version_string();
        if version.split('.').next() != Some("1") {
            return Err(format!(
                "{} is libavif {version}; Oriel drives libavif 1.x",
                path.display()
            ));
        }
        // SAFETY: plain call; returns a static string or null.
        let aom = unsafe { (api.codec_name)(AVIF_CODEC_CHOICE_AOM, AVIF_CODEC_FLAG_CAN_ENCODE) };
        if aom.is_null() {
            return Err(format!(
                "{} is libavif {version} without aom's encoder, which the archive settings need",
                path.display()
            ));
        }
        Ok(api)
    }

    /// libavif's version, as `major.minor.patch`.
    pub fn version_string(&self) -> String {
        // SAFETY: `avifVersion` returns a static, NUL-terminated string.
        unsafe { CStr::from_ptr((self.version)()) }
            .to_string_lossy()
            .into_owned()
    }

    /// The codecs libavif was built with and their versions, such as `dav1d [dec]:1.5.4,
    /// aom [enc/dec]:3.15.2`.
    pub fn codec_versions_string(&self) -> String {
        let mut buffer = [0 as c_char; 256];
        // SAFETY: `avifCodecVersions` writes a NUL-terminated string into its 256-byte buffer.
        unsafe {
            (self.codec_versions)(buffer.as_mut_ptr());
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned()
        }
    }

    pub fn describe(&self, result: AvifResult) -> String {
        // SAFETY: `avifResultToString` returns a static string for any value.
        unsafe { CStr::from_ptr((self.result_to_string)(result)) }
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::mem::{offset_of, size_of};
    use std::path::PathBuf;
    use std::process::Command;

    use super::*;

    /// The vendored set's headers, which describe the libavif it carries.
    fn vendored_include() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.vendor/libavif/current/include")
    }

    /// Compiles a program against the vendored `avif.h` that prints each field's offset, and
    /// compares them with this module's layouts. Skips, saying so, until the set is vendored.
    #[test]
    fn layouts_match_the_vendored_header() {
        let include = vendored_include();
        if !include.join("avif/avif.h").is_file() {
            eprintln!("skipped: no vendored libavif; run `cargo run -p xtask -- vendor libavif`");
            return;
        }
        let fields: Vec<(&str, &str, usize)> = vec![
            ("avifImage", "depth", offset_of!(ImageHead, depth)),
            ("avifImage", "yuvPlanes", offset_of!(ImageHead, yuv_planes)),
            (
                "avifImage",
                "alphaPlane",
                offset_of!(ImageHead, alpha_plane),
            ),
            ("avifImage", "icc", offset_of!(ImageHead, icc)),
            (
                "avifImage",
                "colorPrimaries",
                offset_of!(ImageHead, color_primaries),
            ),
            (
                "avifImage",
                "matrixCoefficients",
                offset_of!(ImageHead, matrix_coefficients),
            ),
            ("avifRGBImage", "format", offset_of!(RgbImage, format)),
            (
                "avifRGBImage",
                "chromaDownsampling",
                offset_of!(RgbImage, chroma_downsampling),
            ),
            (
                "avifRGBImage",
                "maxThreads",
                offset_of!(RgbImage, max_threads),
            ),
            ("avifRGBImage", "pixels", offset_of!(RgbImage, pixels)),
            ("avifRGBImage", "rowBytes", offset_of!(RgbImage, row_bytes)),
            (
                "avifEncoder",
                "codecChoice",
                offset_of!(EncoderHead, codec_choice),
            ),
            (
                "avifEncoder",
                "maxThreads",
                offset_of!(EncoderHead, max_threads),
            ),
            ("avifEncoder", "speed", offset_of!(EncoderHead, speed)),
            ("avifEncoder", "quality", offset_of!(EncoderHead, quality)),
            (
                "avifEncoder",
                "qualityAlpha",
                offset_of!(EncoderHead, quality_alpha),
            ),
            (
                "avifEncoder",
                "tileRowsLog2",
                offset_of!(EncoderHead, tile_rows_log2),
            ),
            (
                "avifEncoder",
                "tileColsLog2",
                offset_of!(EncoderHead, tile_cols_log2),
            ),
            ("avifEncoder", "diag", offset_of!(EncoderHead, diag_error)),
        ];
        let mut program = String::from(
            "#include <stddef.h>\n#include <stdio.h>\n#include <avif/avif.h>\nint main(void) {\n",
        );
        for (structure, field, _) in &fields {
            program.push_str(&format!(
                "  printf(\"%zu\\n\", offsetof({structure}, {field}));\n"
            ));
        }
        program.push_str("  printf(\"%zu\\n\", sizeof(avifRGBImage));\n  return 0;\n}\n");

        let folder = std::env::temp_dir().join(format!("oriel-avif-layout-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let source = folder.join("layout.c");
        let binary = folder.join("layout");
        std::fs::write(&source, program).unwrap();
        let compiled = Command::new("/usr/bin/cc")
            .arg("-I")
            .arg(&include)
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .status()
            .expect("cc runs");
        assert!(compiled.success());
        let output = Command::new(&binary)
            .output()
            .expect("the layout program runs");
        let printed: Vec<usize> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| line.parse().unwrap())
            .collect();

        for ((structure, field, ours), theirs) in fields.iter().zip(&printed) {
            assert_eq!(ours, theirs, "{structure}.{field}");
        }
        assert_eq!(
            printed.last(),
            Some(&size_of::<RgbImage>()),
            "sizeof(avifRGBImage)"
        );
        let _ = std::fs::remove_dir_all(folder);
    }
}
