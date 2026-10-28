//! What the fingerprint conformance test and the parity example share: where the corpus, the
//! vectors and sharp's libvips are, the vectors' shape, and the large still both suites draw.

#![allow(dead_code)]

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

/// Points the tests at a libvips other than the one sharp installed, to try another build.
pub const LIBVIPS_VARIABLE: &str = "ORIEL_GPUI_LIBVIPS";

pub fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fingerprints")
}

pub fn corpus_dir() -> PathBuf {
    conformance_dir().join("corpus")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// The libvips sharp installed under `node_modules` (`pnpm install` puts it there), or the one
/// [`LIBVIPS_VARIABLE`] names.
pub fn libvips_path() -> PathBuf {
    if let Some(chosen) = env::var_os(LIBVIPS_VARIABLE).filter(|value| !value.is_empty()) {
        return PathBuf::from(chosen);
    }
    let store = repo_root().join("node_modules/.pnpm");
    let package = if cfg!(target_os = "windows") {
        "sharp-libvips-win32-x64"
    } else {
        "sharp-libvips-darwin-arm64"
    };
    let found = fs::read_dir(&store).ok().and_then(|entries| {
        entries
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                name.to_string_lossy()
                    .starts_with(&format!("@img+{package}@"))
            })
            .flat_map(|entry| {
                let lib = entry
                    .path()
                    .join("node_modules/@img")
                    .join(package)
                    .join("lib");
                fs::read_dir(lib).into_iter().flatten().flatten()
            })
            .map(|entry| entry.path())
            .find(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                name.starts_with("libvips-cpp.") && name.ends_with(".dylib")
            })
    });
    found.unwrap_or_else(|| {
        panic!(
            "No libvips: run `pnpm install` at the repository root so sharp's libvips is in \
             node_modules, or set {LIBVIPS_VARIABLE} to a libvips dylib."
        )
    })
}

#[derive(Debug, Deserialize)]
pub struct Vectors {
    pub libvips: String,
    pub phash: Vec<PhashVector>,
    pub stills: Vec<StillVector>,
    pub drawn: Vec<DrawnVector>,
    pub animations: Vec<AnimationVector>,
    pub videos: Vec<VideoVector>,
    pub pairs: Vec<PairVector>,
}

#[derive(Debug, Deserialize)]
pub struct PhashVector {
    pub name: String,
    pub pixels: String,
    pub hash: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeVector {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    pub has_alpha: bool,
    pub frame_delays_ms: Vec<i32>,
}

#[derive(Debug, Deserialize)]
pub struct StillVector {
    pub file: String,
    pub probe: ProbeVector,
    pub fingerprint: String,
    pub grey32: String,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
pub struct DrawnVector {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fingerprint: String,
    pub grey32: String,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationVector {
    pub file: String,
    pub probe: ProbeVector,
    pub frame_times_ms: Vec<u32>,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoVector {
    pub file: String,
    pub duration_ms: f64,
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
pub struct PairVector {
    pub left: String,
    pub right: String,
    pub distance: u32,
    pub variant: bool,
}

pub fn vectors() -> Vectors {
    let path = conformance_dir().join("vectors.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("Malformed vectors: {error}"))
}

pub fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex vectors"))
        .collect()
}

/// The large still's pixels, as `drawLarge` in `fingerprint-vectors.test.ts` draws them: integer
/// arithmetic only, so both suites make the same bytes.
pub fn draw_large(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 3);
    for y in 0..i64::from(height) {
        for x in 0..i64::from(width) {
            let red = x * 255 / (i64::from(width) - 1);
            let green = y * 255 / (i64::from(height) - 1);
            let disc = (x - 3600).pow(2) + (y - 1700).pow(2) < 900 * 900;
            let tile = (x / 750 + y / 500) % 2 == 1;
            pixels.push(if disc { 255 - red } else { red } as u8);
            pixels.push(green as u8);
            pixels.push(if disc {
                230
            } else if tile {
                150
            } else {
                40
            });
        }
    }
    pixels
}

/// A fresh folder under the temp folder, removed when dropped.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Scratch {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("a scratch folder");
        Scratch(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Writes the large still as an 8-bit RGB PNG, which decodes to the same pixels as the one
/// glazier-core's suite writes with sharp.
pub fn write_large_png(dir: &Path, drawn: &DrawnVector) -> PathBuf {
    let path = dir.join(format!("{}.png", drawn.name));
    image::save_buffer(
        &path,
        &draw_large(drawn.width, drawn.height),
        drawn.width,
        drawn.height,
        image::ExtendedColorType::Rgb8,
    )
    .expect("the large still");
    path
}

/// Whether `ffmpeg` runs from PATH, as glazier-core's suite finds it.
pub fn has_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .is_ok_and(|output| output.status.success())
}
