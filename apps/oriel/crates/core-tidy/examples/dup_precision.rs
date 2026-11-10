//! Measures Spot variants against a copy of a catalog (plan 061): how many of the owner's "not
//! duplicates" decisions it honours, how many copies generated from their stills it still calls
//! copies, and what it makes of the open sets. It prints numbers only, never a path or a name.
//!
//! The owner's files are only read; the catalog is copied into the scratch folder first, and every
//! change goes to that copy. Dismissals and generated copies split into a training half and a test
//! half by dismissal or by source file; thresholds are set on `train` and reported on `test`.
//!
//! ```sh
//! # 1. Generate copies under <scratch>/copies: needs avifenc on the PATH beside the app's ffmpeg.
//! cargo run --release -p oriel-core-tidy --example dup_precision -- \
//!   copies <catalog> <scratch> [threads] [sources per kind]
//! # 2. Before and after on one half, on both with `all`, or on what the owner decided since a
//! # date, with the copies they removed that are still in holding.
//! cargo run --release -p oriel-core-tidy --example dup_precision -- \
//!   measure <catalog> <scratch> train|test|all|since:2026-11-05 [threads]
//! # 3. The open sets and bytes, the CPU an analysis takes and what it adds to the catalog.
//! cargo run --release -p oriel-core-tidy --example dup_precision -- library <catalog> <scratch>
//! # 4. Video copies at Shrink's settings and harder ones, which `measure` then counts.
//! cargo run --release -p oriel-core-tidy --example dup_precision -- \
//!   video-copies <catalog> <scratch> [threads] [sources per kind]
//! ```

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use futures::executor::block_on;
use oriel_avif::Libavif;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::AnalysisKind;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    DuplicateKind, DuplicateScope, DuplicateSetRequest, FileId, Settings, SimilarityLevel,
};
use oriel_core_tidy::internals::Catalog;
use oriel_core_tidy::internals::build_duplicate_sets;
use oriel_core_tidy::internals::encode_still_to_avif;
use oriel_core_tidy::internals::{
    ClusterKind, DETAIL_VERSION, Fingerprint, SimilarCluster, StillLook, detail_difference,
    fingerprint_still, frames_show_variant, is_variant, look_at_still, look_measures,
    look_shows_variant, normalize_detail, open_libvips, still_threshold,
};
use oriel_core_tidy::{Media, Progress};
use oriel_runtime::CancelToken;
use oriel_vips::Vips;
use rusqlite::{Connection, OpenFlags, params};

/// The start of 2026-10-27, local time: what was dismissed from here on got past Spot variants as
/// plan 061 first shipped it.
const AFTER_SPOT_VARIANTS_MS: i64 = 1_793_052_000_000;

/// Which of the owner's decisions a run measures.
#[derive(Clone, Copy)]
struct Selection {
    half: Option<u8>,
    since_ms: Option<i64>,
}

impl Selection {
    fn holds(self, dismissal: i64, created_at: i64) -> bool {
        self.half.is_none_or(|half| half == half_of(dismissal))
            && self.since_ms.is_none_or(|since| created_at >= since)
    }
}

/// A file's or a dismissal's half: 0 is `train`, 1 is `test`.
fn half_of(key: i64) -> u8 {
    (((key as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 40) & 1) as u8
}

#[derive(Clone, Copy)]
enum Encoder {
    Png,
    /// ffmpeg's MJPEG quantiser, and whether the colour keeps its full size.
    Jpeg(u32, bool),
    Webp(u32),
    Avifenc(u32),
    /// Tidy's own Convert.
    Convert,
    JpegThenConvert(u32),
    WebpThenConvert(u32),
    /// Saved as a mediocre JPEG, resized, and saved as one again.
    Reposted,
    /// One frame through SVT-AV1 at this CRF, as a shrink treats video. Stills never go this way
    /// in Tidy, and videos have no detail print, so this only checks the rule's margin.
    Av1Frame(u32),
}

const HALF: &str = "scale=trunc(iw*0.5):trunc(ih*0.5):flags=lanczos";

/// How copies are made: a name, an ffmpeg filter, and the encoder.
const COPIES: &[(&str, &str, Encoder)] = &[
    ("j95", "", Encoder::Jpeg(2, true)),
    ("j85", "", Encoder::Jpeg(5, false)),
    ("j70", "", Encoder::Jpeg(10, false)),
    ("j45", "", Encoder::Jpeg(20, false)),
    ("w80", "", Encoder::Webp(80)),
    ("w50", "", Encoder::Webp(50)),
    ("a60", "", Encoder::Avifenc(60)),
    ("convert", "", Encoder::Convert),
    ("half", HALF, Encoder::Png),
    (
        "s75j85",
        "scale=trunc(iw*0.75):trunc(ih*0.75):flags=bicubic",
        Encoder::Jpeg(5, false),
    ),
    (
        "l1280j80",
        "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)':flags=bilinear",
        Encoder::Jpeg(7, false),
    ),
    (
        "s33w75",
        "scale=trunc(iw*0.33):trunc(ih*0.33):flags=bicubic",
        Encoder::Webp(75),
    ),
    (
        "up150j90",
        "scale=trunc(iw*1.5):trunc(ih*1.5):flags=lanczos",
        Encoder::Jpeg(3, false),
    ),
    ("s50j85c", HALF, Encoder::JpegThenConvert(5)),
    ("j80c", "", Encoder::JpegThenConvert(7)),
    (
        "s70w80c",
        "scale=trunc(iw*0.7):trunc(ih*0.7):flags=area",
        Encoder::WebpThenConvert(80),
    ),
    (
        "av1crf35",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        Encoder::Av1Frame(35),
    ),
    ("crop2j90", "crop=iw-4:ih-4:2:2", Encoder::Jpeg(3, false)),
    ("sharpj85", "unsharp=5:5:0.8", Encoder::Jpeg(5, false)),
    ("gammaj90", "eq=gamma=1.06", Encoder::Jpeg(3, false)),
    ("satj90", "eq=saturation=1.08", Encoder::Jpeg(3, false)),
    (
        "s25j80",
        "scale=trunc(iw*0.25):trunc(ih*0.25):flags=bicubic",
        Encoder::Jpeg(7, false),
    ),
    (
        "repost",
        "scale=trunc(iw*0.6):trunc(ih*0.6):flags=bicubic",
        Encoder::Reposted,
    ),
];

/// Pairs of copies of one source, as two sites' copies of one picture meet in a library.
const COPY_PAIRS: &[(&str, &str)] = &[
    ("convert", "s50j85c"),
    ("convert", "j80c"),
    ("s50j85c", "s70w80c"),
    ("j85", "l1280j80"),
    ("w80", "s33w75"),
];

fn succeeded(arguments: &[&str]) -> bool {
    Command::new(arguments[0])
        .args(&arguments[1..])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// The ffmpeg the app ships, which has every encoder here but avifenc's.
fn ffmpeg_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = Media::locate().ffmpeg.expect("the app's ffmpeg");
        path.to_string_lossy().into_owned()
    })
}

fn ffmpeg(input: &str, filter: &str, extra: &[&str], out: &str) -> bool {
    let mut arguments = vec![
        ffmpeg_path(),
        "-y",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-i",
        input,
    ];
    if !filter.is_empty() {
        arguments.extend(["-vf", filter]);
    }
    arguments.extend(extra);
    arguments.push(out);
    succeeded(&arguments)
}

fn jpeg(input: &str, quantiser: u32, full_colour: bool, out: &str) -> bool {
    let quantiser = quantiser.to_string();
    let pixels = if full_colour { "yuvj444p" } else { "yuvj420p" };
    ffmpeg(input, "", &["-q:v", &quantiser, "-pix_fmt", pixels], out)
}

fn webp(input: &str, quality: u32, out: &str) -> bool {
    let quality = quality.to_string();
    ffmpeg(input, "", &["-c:v", "libwebp", "-q:v", &quality], out)
}

/// Makes one copy of the picture at `source` under `folder`, as `stem` plus the encoder's
/// extension, and returns where.
fn make_copy(
    vips: &Vips,
    libavif: &Libavif,
    source: &str,
    filter: &str,
    encoder: Encoder,
    folder: &Path,
    stem: &str,
) -> Option<PathBuf> {
    let working = |extension: &str| folder.join(format!("{stem}-working.{extension}"));
    let final_at = |extension: &str| folder.join(format!("{stem}.{extension}"));
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let png = working("png");
    if !ffmpeg(source, filter, &[], &text(&png)) {
        return None;
    }
    let convert = |from: &Path, out: &Path| encode_still_to_avif(vips, libavif, from, out).is_ok();
    let made = match encoder {
        Encoder::Png => {
            let out = final_at("png");
            std::fs::rename(&png, &out).ok().map(|()| out)
        }
        Encoder::Jpeg(quantiser, full_colour) => {
            let out = final_at("jpg");
            jpeg(&text(&png), quantiser, full_colour, &text(&out)).then_some(out)
        }
        Encoder::Webp(quality) => {
            let out = final_at("webp");
            webp(&text(&png), quality, &text(&out)).then_some(out)
        }
        Encoder::Avifenc(quality) => {
            let out = final_at("avif");
            succeeded(&[
                "avifenc",
                "-q",
                &quality.to_string(),
                "-s",
                "8",
                "-j",
                "1",
                &text(&png),
                &text(&out),
            ])
            .then_some(out)
        }
        Encoder::Convert => {
            let out = final_at("avif");
            convert(&png, &out).then_some(out)
        }
        Encoder::JpegThenConvert(quantiser) => {
            let (middle, out) = (working("jpg"), final_at("avif"));
            (jpeg(&text(&png), quantiser, false, &text(&middle)) && convert(&middle, &out))
                .then_some(out)
        }
        Encoder::WebpThenConvert(quality) => {
            let (middle, out) = (working("webp"), final_at("avif"));
            (webp(&text(&png), quality, &text(&middle)) && convert(&middle, &out)).then_some(out)
        }
        Encoder::Av1Frame(crf) => {
            let (middle, out) = (working("mkv"), final_at("png"));
            let crf = crf.to_string();
            let encoded = ffmpeg(
                &text(&png),
                "",
                &[
                    "-c:v",
                    "libsvtav1",
                    "-crf",
                    &crf,
                    "-frames:v",
                    "1",
                    "-pix_fmt",
                    "yuv420p",
                ],
                &text(&middle),
            );
            (encoded && ffmpeg(&text(&middle), "", &["-frames:v", "1"], &text(&out))).then_some(out)
        }
        Encoder::Reposted => {
            let (first, resized, out) = (working("jpg"), working("2.png"), final_at("jpg"));
            (jpeg(&text(&png), 12, false, &text(&first))
                && ffmpeg(
                    &text(&first),
                    "scale=trunc(iw*0.8):trunc(ih*0.8):flags=bicubic",
                    &[],
                    &text(&resized),
                )
                && jpeg(&text(&resized), 12, false, &text(&out)))
            .then_some(out)
        }
    };
    for extension in ["png", "jpg", "webp", "mkv", "2.png"] {
        let _ = std::fs::remove_file(working(extension));
    }
    made
}

fn read_only(catalog: &str) -> Connection {
    Connection::open_with_flags(catalog, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn path_of(root: &str, rel_path: &str) -> PathBuf {
    Path::new(root).join(rel_path)
}

/// Stills from `sql`, which selects id, root path, relative path and pixels, in a fixed shuffled
/// order; those over 20 megapixels are left out to keep encoding time down.
fn sample(connection: &Connection, sql: &str, count: usize) -> Vec<(FileId, PathBuf)> {
    let mut statement = connection.prepare(sql).unwrap();
    let mut rows: Vec<(FileId, PathBuf, i64)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                path_of(&row.get::<_, String>(1)?, &row.get::<_, String>(2)?),
                row.get(3)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    rows.sort_by_key(|(id, _, _)| (*id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    rows.into_iter()
        .filter(|(_, _, pixels)| *pixels <= 20_000_000)
        .take(count)
        .map(|(id, path, _)| (id, path))
        .collect()
}

/// Generates the copies: dismissed stills, printed stills, and stills of neither kind.
fn generate(catalog: &str, scratch: &Path, threads: usize, per_kind: usize) {
    let connection = read_only(catalog);
    let vips = open_libvips().unwrap();
    let libavif = Libavif::get().unwrap();
    let select = "SELECT f.id, r.path, f.rel_path, f.width * f.height FROM files f
      JOIN roots r ON r.id = f.root_id WHERE f.fingerprint LIKE 's:%'";
    let dismissed = "(SELECT file_id FROM duplicate_dismissal_files)";
    let mut sources = sample(
        &connection,
        &format!("{select} AND f.id IN {dismissed}"),
        per_kind,
    );
    sources.extend(sample(
        &connection,
        &format!(
            "{select} AND f.id NOT IN {dismissed} AND f.id IN (SELECT file_id FROM file_details)"
        ),
        per_kind,
    ));
    sources.extend(sample(
        &connection,
        &format!(
            "{select} AND f.id NOT IN {dismissed} \
             AND f.id NOT IN (SELECT file_id FROM file_details)"
        ),
        per_kind,
    ));

    let folder = scratch.join("copies");
    std::fs::create_dir_all(&folder).unwrap();
    let next = AtomicUsize::new(0);
    let (made, failed) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some((id, path)) = sources.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let Ok((width, height, pixels)) = vips.rgba_pixels(path) else {
                        failed.fetch_add(COPIES.len(), Ordering::Relaxed);
                        continue;
                    };
                    let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
                    ppm.reserve(pixels.len() / 4 * 3);
                    for pixel in pixels.as_chunks::<4>().0 {
                        let alpha = u32::from(pixel[3]);
                        for &value in &pixel[..3] {
                            let laid = (u32::from(value) * alpha + 255 * (255 - alpha) + 127) / 255;
                            ppm.push(laid as u8);
                        }
                    }
                    drop(pixels);
                    let source = folder.join(format!("{id}-source.ppm"));
                    std::fs::write(&source, ppm).unwrap();
                    let source_text = source.to_string_lossy();
                    for (name, filter, encoder) in COPIES {
                        let stem = format!("{id}_{name}");
                        let done = std::fs::read_dir(&folder).is_ok_and(|mut entries| {
                            entries.any(|entry| {
                                entry.is_ok_and(|entry| {
                                    entry.file_name().to_string_lossy().starts_with(&stem)
                                })
                            })
                        });
                        if done {
                            continue;
                        }
                        let copied = make_copy(
                            &vips,
                            libavif,
                            &source_text,
                            filter,
                            *encoder,
                            &folder,
                            &stem,
                        );
                        if copied.is_some() {
                            made.fetch_add(1, Ordering::Relaxed);
                        } else {
                            failed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    let _ = std::fs::remove_file(&source);
                    oriel_runtime::release_free_memory();
                }
            });
        }
    });
    println!(
        "{} sources: {} copies made, {} failed, in {:.0} s",
        sources.len(),
        made.load(Ordering::Relaxed),
        failed.load(Ordering::Relaxed),
        started.elapsed().as_secs_f64()
    );
}

/// The print plan 061 first shipped: 256×256 grey from the decoder's resize, averaged 4×4. Here
/// with its rule so the two can be compared on one run.
fn old_print(vips: &Vips, path: &Path) -> Option<Vec<f32>> {
    const AVERAGED: usize = 4;
    let side = 64 * AVERAGED;
    let pixels = vips.grey_pixels(path, side as u32, None).ok()?;
    let mut print = vec![0u8; 64 * 64];
    for row in 0..64 {
        for column in 0..64 {
            let mut sum = 0u32;
            for y in 0..AVERAGED {
                let start = (row * AVERAGED + y) * side + column * AVERAGED;
                sum += pixels[start..start + AVERAGED]
                    .iter()
                    .map(|&value| u32::from(value))
                    .sum::<u32>();
            }
            print[row * 64 + column] = ((sum + 8) / 16) as u8;
        }
    }
    Some(normalize_detail(&print))
}

fn old_is_variant(left: &[f32], right: &[f32]) -> bool {
    let difference = detail_difference(left, right);
    difference.local > 4.0 || (difference.typical <= 0.05 && difference.local > 1.0)
}

/// A still measured every way the two rules need.
struct Measured {
    look: StillLook,
    print: Vec<u8>,
    normal: Vec<f32>,
    old: Vec<f32>,
    hash: u64,
}

fn measure_still(vips: &Vips, path: &Path) -> Option<Measured> {
    let look = look_at_still(vips, path).ok()?;
    let print = look.print();
    let normal = normalize_detail(&print);
    let old = old_print(vips, path)?;
    let hash = match fingerprint_still(vips, path).ok()? {
        Fingerprint::Still(hash) => hash.0,
        Fingerprint::Motion { .. } => return None,
    };
    Some(Measured {
        look,
        print,
        normal,
        old,
        hash,
    })
}

/// Where a run notes how each pair measured, for looking at margins: labels and numbers only.
static PAIRS: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

fn note_pair(label: &str, half: u8, group: i64, kind: &str, left: &Measured, right: &Measured) {
    let Some(pairs) = PAIRS.get() else {
        return;
    };
    let print = detail_difference(&left.normal, &right.normal);
    let look = look_measures(&left.look, &right.look);
    writeln!(
        pairs.lock().unwrap(),
        "{label}\t{half}\t{group}\t{kind}\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.4}\t{:.3}\t{}\t{}",
        u8::from(look.same_size),
        print.local,
        print.typical,
        look.spot,
        look.matching,
        look.colour_shift,
        u8::from(old_is_variant(&left.old, &right.old)),
        u8::from(
            is_variant(&left.normal, &right.normal) || look_shows_variant(&left.look, &right.look)
        ),
    )
    .unwrap();
}

#[derive(Default)]
struct Tally {
    total: usize,
    variant_before: usize,
    variant_now: usize,
    /// How many the print alone calls variants, and the closer look alone.
    by_print: usize,
    by_look: usize,
    within_balanced: usize,
}

impl Tally {
    fn add(&mut self, left: &Measured, right: &Measured) {
        self.total += 1;
        self.variant_before += usize::from(old_is_variant(&left.old, &right.old));
        let (print, look) = (
            is_variant(&left.normal, &right.normal),
            look_shows_variant(&left.look, &right.look),
        );
        self.variant_now += usize::from(print || look);
        self.by_print += usize::from(print);
        self.by_look += usize::from(look);
        let distance = (left.hash ^ right.hash).count_ones();
        self.within_balanced += usize::from(distance <= still_threshold(SimilarityLevel::Balanced));
    }

    fn merge(&mut self, other: &Tally) {
        self.total += other.total;
        self.variant_before += other.variant_before;
        self.variant_now += other.variant_now;
        self.by_print += other.by_print;
        self.by_look += other.by_look;
        self.within_balanced += other.within_balanced;
    }
}

fn share(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 * 100.0 / whole as f64
    }
}

/// Generated copies in one half: how many are still called copies, by how they were made.
fn measure_copies(
    connection: &Connection,
    scratch: &Path,
    half: Option<u8>,
    threads: usize,
    half_of_source: &HashMap<FileId, u8>,
) {
    let vips = open_libvips().unwrap();
    let folder = scratch.join("copies");
    let mut by_source: BTreeMap<FileId, BTreeMap<String, PathBuf>> = BTreeMap::new();
    for entry in std::fs::read_dir(&folder).unwrap().flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some((stem, _)) = file_name.split_once('.') else {
            continue;
        };
        let Some((id, name)) = stem.split_once('_') else {
            continue;
        };
        if let Ok(id) = id.parse() {
            by_source
                .entry(id)
                .or_default()
                .insert(name.to_owned(), entry.path());
        }
    }
    let mut sources: Vec<(FileId, PathBuf, BTreeMap<String, PathBuf>)> = Vec::new();
    for (id, copies) in by_source {
        let in_half = half_of_source
            .get(&id)
            .copied()
            .unwrap_or_else(|| half_of(id));
        if half.is_some_and(|half| half != in_half) {
            continue;
        }
        let Ok(path) = connection.query_row(
            "SELECT r.path, f.rel_path FROM files f JOIN roots r ON r.id = f.root_id
              WHERE f.id = ?1",
            [id],
            |row| {
                Ok(path_of(
                    &row.get::<_, String>(0)?,
                    &row.get::<_, String>(1)?,
                ))
            },
        ) else {
            continue;
        };
        sources.push((id, path, copies));
    }

    let tallies: Mutex<BTreeMap<String, Tally>> = Mutex::new(BTreeMap::new());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some((id, path, copies)) =
                    sources.get(next.fetch_add(1, Ordering::Relaxed))
                {
                    let half = half_of_source
                        .get(id)
                        .copied()
                        .unwrap_or_else(|| half_of(*id));
                    let Some(source) = measure_still(&vips, path) else {
                        continue;
                    };
                    let mut measured: HashMap<&str, Measured> = HashMap::new();
                    for (name, copy) in copies {
                        let Some(copied) = measure_still(&vips, copy) else {
                            continue;
                        };
                        let mut tallies = tallies.lock().unwrap();
                        tallies
                            .entry(name.clone())
                            .or_default()
                            .add(&source, &copied);
                        note_pair("copy", half, *id, name, &source, &copied);
                        drop(tallies);
                        if COPY_PAIRS
                            .iter()
                            .any(|(left, right)| left == name || right == name)
                        {
                            measured.insert(name, copied);
                        }
                    }
                    for (left, right) in COPY_PAIRS {
                        if let (Some(left_copy), Some(right_copy)) =
                            (measured.get(left), measured.get(right))
                        {
                            tallies
                                .lock()
                                .unwrap()
                                .entry(format!("{left}~{right}"))
                                .or_default()
                                .add(left_copy, right_copy);
                        }
                    }
                    oriel_runtime::release_free_memory();
                }
            });
        }
    });
    let tallies = tallies.into_inner().unwrap();
    let mut all = Tally::default();
    println!(
        "\nGenerated copies (still copies: before, now; variants by print, by look; within \
         Balanced's fingerprint)"
    );
    for (name, tally) in &tallies {
        all.merge(tally);
        println!(
            "  {name:<20} {:>4} pairs  {:>4} ({:>5.1}%)  {:>4} ({:>5.1}%)  {:>3} {:>3}  {:>5.1}%",
            tally.total,
            tally.total - tally.variant_before,
            share(tally.total - tally.variant_before, tally.total),
            tally.total - tally.variant_now,
            share(tally.total - tally.variant_now, tally.total),
            tally.by_print,
            tally.by_look,
            share(tally.within_balanced, tally.total),
        );
    }
    println!(
        "  all {} pairs from {} sources: before {} ({:.1}%), now {} ({:.1}%); \
         within Balanced's fingerprint {:.1}%",
        all.total,
        sources.len(),
        all.total - all.variant_before,
        share(all.total - all.variant_before, all.total),
        all.total - all.variant_now,
        share(all.total - all.variant_now, all.total),
        share(all.within_balanced, all.total),
    );
}

/// One still in a dismissal, as the catalog has it.
struct DismissedStill {
    id: FileId,
    path: PathBuf,
    content: String,
    size: i64,
    mtime_ms: f64,
}

struct Dismissal {
    id: i64,
    created_at: i64,
    stills: Vec<DismissedStill>,
}

/// What measuring a dismissal found, to put in the scratch catalog and count.
#[derive(Default)]
struct DismissalFound {
    prints: Vec<(FileId, Vec<u8>)>,
    comparisons: Vec<(FileId, FileId, bool)>,
    old_prints: HashMap<FileId, Vec<f32>>,
    pairs: Tally,
}

fn dismissed_stills(connection: &Connection, selection: Selection) -> Vec<Dismissal> {
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.created_at, f.id, r.path, f.rel_path, f.sha256, f.size, f.mtime_ms
          FROM duplicate_dismissals d
          JOIN duplicate_dismissal_files x ON x.dismissal_id = d.id
          JOIN files f ON f.id = x.file_id JOIN roots r ON r.id = f.root_id
          WHERE f.fingerprint LIKE 's:%' ORDER BY d.id, f.id",
        )
        .unwrap();
    let mut dismissals: BTreeMap<i64, Dismissal> = BTreeMap::new();
    let rows = statement
        .query_map([], |row| {
            let id: FileId = row.get(2)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                DismissedStill {
                    id,
                    path: path_of(&row.get::<_, String>(3)?, &row.get::<_, String>(4)?),
                    content: row
                        .get::<_, Option<String>>(5)?
                        .unwrap_or_else(|| format!("file:{id}")),
                    size: row.get(6)?,
                    mtime_ms: row.get(7)?,
                },
            ))
        })
        .unwrap();
    for row in rows {
        let (id, created_at, still) = row.unwrap();
        dismissals
            .entry(id)
            .or_insert_with(|| Dismissal {
                id,
                created_at,
                stills: Vec::new(),
            })
            .stills
            .push(still);
    }
    dismissals
        .into_values()
        .filter(|dismissal| selection.holds(dismissal.id, dismissal.created_at))
        .collect()
}

/// Dismissals of videos in one half: when, whether all their files hold one content, and the ids.
fn dismissed_videos(
    connection: &Connection,
    selection: Selection,
) -> Vec<(i64, bool, Vec<FileId>)> {
    let mut statement = connection
        .prepare(
            "SELECT d.id, d.created_at, f.id, f.sha256 FROM duplicate_dismissals d
          JOIN duplicate_dismissal_files x ON x.dismissal_id = d.id
          JOIN files f ON f.id = x.file_id
          WHERE f.fingerprint LIKE 'm:%' ORDER BY d.id, f.id",
        )
        .unwrap();
    type Rows = BTreeMap<i64, (i64, HashSet<String>, Vec<FileId>)>;
    let mut dismissals: Rows = BTreeMap::new();
    let rows = statement
        .query_map([], |row| {
            let id: FileId = row.get(2)?;
            let content = row
                .get::<_, Option<String>>(3)?
                .unwrap_or_else(|| format!("file:{id}"));
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, id, content))
        })
        .unwrap();
    for row in rows {
        let (dismissal, created_at, id, content) = row.unwrap();
        let entry = dismissals
            .entry(dismissal)
            .or_insert_with(|| (created_at, HashSet::new(), Vec::new()));
        entry.1.insert(content);
        entry.2.push(id);
    }
    dismissals
        .into_iter()
        .filter(|(id, (created_at, ..))| selection.holds(*id, *created_at))
        .map(|(_, (created_at, contents, ids))| (created_at, contents.len() < 2, ids))
        .collect()
}

/// The owner's dismissals in one half, before and after, through the code the app runs: a scratch
/// catalog gets the prints and comparisons, and each dismissal is offered as one similar set.
fn measure_dismissals(
    connection: &Connection,
    scratch: &Path,
    selection: Selection,
    threads: usize,
) {
    let dismissals = dismissed_stills(connection, selection);
    let vips = open_libvips().unwrap();
    let found: Mutex<HashMap<i64, DismissalFound>> = Mutex::new(HashMap::new());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some(dismissal) = dismissals.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let mut seen: HashMap<&str, &DismissedStill> = HashMap::new();
                    for still in &dismissal.stills {
                        seen.entry(&still.content).or_insert(still);
                    }
                    let distinct: Vec<&DismissedStill> = seen.values().copied().collect();
                    let measured: Vec<(&DismissedStill, Measured)> = distinct
                        .iter()
                        .filter_map(|still| Some((*still, measure_still(&vips, &still.path)?)))
                        .collect();
                    let mut found_here = DismissalFound::default();
                    for (still, measuring) in &measured {
                        found_here.prints.push((still.id, measuring.print.clone()));
                        found_here
                            .old_prints
                            .insert(still.id, measuring.old.clone());
                    }
                    for (index, (left_still, left)) in measured.iter().enumerate() {
                        for (right_still, right) in &measured[index + 1..] {
                            found_here.pairs.add(left, right);
                            let half = half_of(dismissal.id);
                            note_pair("variant", half, dismissal.id, "dismissed", left, right);
                            let pair = (
                                left_still.id.min(right_still.id),
                                left_still.id.max(right_still.id),
                                look_shows_variant(&left.look, &right.look),
                            );
                            found_here.comparisons.push(pair);
                        }
                    }
                    found.lock().unwrap().insert(dismissal.id, found_here);
                    oriel_runtime::release_free_memory();
                }
            });
        }
    });
    let found = found.into_inner().unwrap();

    let copy = scratch.join("measure.sqlite");
    let _ = std::fs::remove_file(&copy);
    connection
        .execute_batch(&format!("VACUUM INTO '{}'", copy.display()))
        .unwrap();
    let catalog = Catalog::open_blocking(&copy).unwrap();
    let details_of: Vec<(FileId, i64, f64, Vec<u8>)> = dismissals
        .iter()
        .flat_map(|dismissal| {
            let prints: HashMap<FileId, &Vec<u8>> = found
                .get(&dismissal.id)
                .map(|found| {
                    found
                        .prints
                        .iter()
                        .map(|(id, print)| (*id, print))
                        .collect()
                })
                .unwrap_or_default();
            // Files of one content in a dismissal share the print measured for the first.
            let by_content: HashMap<&str, &Vec<u8>> = dismissal
                .stills
                .iter()
                .filter_map(|still| Some((still.content.as_str(), *prints.get(&still.id)?)))
                .collect();
            dismissal
                .stills
                .iter()
                .filter_map(|still| {
                    Some((
                        still.id,
                        still.size,
                        still.mtime_ms,
                        (*by_content.get(still.content.as_str())?).clone(),
                    ))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    let states: HashMap<FileId, (i64, f64)> = dismissals
        .iter()
        .flat_map(|dismissal| {
            dismissal
                .stills
                .iter()
                .map(|still| (still.id, (still.size, still.mtime_ms)))
        })
        .collect();
    let comparisons: Vec<(FileId, FileId, bool)> = found
        .values()
        .flat_map(|found| found.comparisons.iter().copied())
        .collect();
    let dismissed_ids: Vec<Vec<FileId>> = dismissals
        .iter()
        .map(|dismissal| dismissal.stills.iter().map(|still| still.id).collect())
        .collect();
    let video_dismissals = dismissed_videos(connection, selection);
    let video_ids: Vec<Vec<FileId>> = video_dismissals
        .iter()
        .map(|(_, _, ids)| ids.clone())
        .collect();
    let ids_for_filter = [dismissed_ids.concat(), video_ids.concat()].concat();

    let (now, off) = catalog
        .blocking(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute("DELETE FROM file_details", [])?;
            // Exact groups only among the dismissed, so each dismissal stays one set.
            transaction.execute(
                "UPDATE files SET sha256 = NULL WHERE id NOT IN
                   (SELECT value FROM json_each(?1))",
                [serde_json::to_string(&ids_for_filter)?],
            )?;
            for (id, size, mtime_ms, print) in details_of {
                transaction.execute(
                    "INSERT INTO file_details (file_id, version, size, mtime_ms, print)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, DETAIL_VERSION, size, mtime_ms, print],
                )?;
            }
            for (left, right, variant) in comparisons {
                let (Some(left_state), Some(right_state)) = (states.get(&left), states.get(&right))
                else {
                    continue;
                };
                transaction.execute(
                    "INSERT OR REPLACE INTO file_comparisons (left_id, right_id, version, left_size,
                       left_mtime_ms, right_size, right_mtime_ms, variant)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        left,
                        right,
                        DETAIL_VERSION,
                        left_state.0,
                        left_state.1,
                        right_state.0,
                        right_state.1,
                        variant
                    ],
                )?;
            }
            transaction.commit()?;
            let clusters: Vec<SimilarCluster> = dismissed_ids
                .into_iter()
                .map(|ids| (ClusterKind::Image, ids))
                .chain(video_ids.into_iter().map(|ids| (ClusterKind::Video, ids)))
                .filter(|(_, ids)| ids.len() > 1)
                .map(|(kind, ids)| SimilarCluster {
                    kind,
                    distance: 0,
                    ids,
                })
                .collect();
            let on = Settings {
                spot_variants: true,
                ..Settings::default()
            };
            let off = Settings {
                spot_variants: false,
                ..Settings::default()
            };
            Ok((
                build_duplicate_sets(connection, None, &on, &clusters)?,
                build_duplicate_sets(connection, None, &off, &clusters)?,
            ))
        })
        .unwrap();

    let group_now: HashMap<FileId, usize> = now
        .iter()
        .enumerate()
        .flat_map(|(index, set)| set.file_ids.iter().map(move |id| (*id, index)))
        .collect();
    let group_off: HashMap<FileId, usize> = off
        .iter()
        .enumerate()
        .flat_map(|(index, set)| set.file_ids.iter().map(move |id| (*id, index)))
        .collect();

    #[derive(Default)]
    struct Counts {
        sets: usize,
        honoured_before: usize,
        honoured_now: usize,
        offered_before: i64,
        offered_now: i64,
    }
    let mut all = Counts::default();
    let mut later = Counts::default();
    let (mut identical_only, mut pairs) = (0, Tally::default());
    for dismissal in &dismissals {
        let contents: HashSet<&str> = dismissal
            .stills
            .iter()
            .map(|still| still.content.as_str())
            .collect();
        if contents.len() < 2 {
            identical_only += 1;
            continue;
        }
        if let Some(found) = found.get(&dismissal.id) {
            pairs.merge(&found.pairs);
        }
        let first = dismissal.stills[0].id;
        let (Some(&now_index), Some(&off_index)) = (group_now.get(&first), group_off.get(&first))
        else {
            continue;
        };
        let (set_now, set_off) = (&now[now_index], &off[off_index]);

        // The rule as first shipped: in keeper order, a version joins the first picture whose best
        // version its print is a copy of.
        let old_prints = found.get(&dismissal.id).map(|found| &found.old_prints);
        let mut heads: Vec<&Vec<f32>> = Vec::new();
        let (mut joined_before, mut no_print) = (0i64, false);
        for version in &set_off.set.versions {
            let print = version
                .files
                .iter()
                .find_map(|file| old_prints.and_then(|prints| prints.get(&file.id)));
            let Some(print) = print else {
                no_print = true;
                break;
            };
            if heads.iter().any(|head| !old_is_variant(head, print)) {
                joined_before += version.files.len() as i64;
            } else {
                heads.push(print);
            }
        }
        if no_print {
            continue;
        }
        for counts in [
            Some(&mut all),
            (dismissal.created_at >= AFTER_SPOT_VARIANTS_MS).then_some(&mut later),
        ]
        .into_iter()
        .flatten()
        {
            counts.sets += 1;
            counts.honoured_before += usize::from(joined_before == 0);
            counts.honoured_now += usize::from(set_now.variants);
            counts.offered_before += joined_before;
            counts.offered_now += i64::from(!set_now.variants)
                * set_now
                    .set
                    .versions
                    .iter()
                    .zip(set_now.set.pictures.iter().flatten())
                    .fold(
                        (Vec::new(), 0),
                        |(mut seen, offered), (version, picture)| {
                            let extra = if seen.contains(picture) {
                                version.files.len() as i64
                            } else {
                                seen.push(*picture);
                                0
                            };
                            (seen, offered + extra)
                        },
                    )
                    .1;
        }
    }
    let (mut video_sets, mut video_now, mut video_identical) = (0, 0, 0);
    let (mut video_later, mut video_later_now) = (0, 0);
    for (created_at, identical, ids) in &video_dismissals {
        if *identical {
            video_identical += 1;
            continue;
        }
        let Some(set) = ids
            .first()
            .and_then(|id| group_now.get(id))
            .map(|at| &now[*at])
        else {
            continue;
        };
        video_sets += 1;
        video_now += usize::from(set.variants);
        if *created_at >= AFTER_SPOT_VARIANTS_MS {
            video_later += 1;
            video_later_now += usize::from(set.variants);
        }
    }
    println!(
        "Dismissals of video: {video_sets} ({video_identical} more hold only identical bytes); \
         every version kept before 0 (Spot variants left video alone), now {video_now} \
         ({:.1}%); since 2026-10-27 {video_later_now} of {video_later}",
        share(video_now, video_sets),
    );
    println!(
        "Dismissals of stills: {} ({identical_only} hold only identical bytes, left out)",
        dismissals.len()
    );
    println!(
        "Variant pairs: {}; caught before {} ({:.1}%), now {} ({:.1}%), by print {}, by look {}",
        pairs.total,
        pairs.variant_before,
        share(pairs.variant_before, pairs.total),
        pairs.variant_now,
        share(pairs.variant_now, pairs.total),
        pairs.by_print,
        pairs.by_look,
    );
    for (label, counts) in [("every dismissal", &all), ("since 2026-10-27", &later)] {
        println!(
            "Sets, {label}: {}; every version kept before {} ({:.1}%), now {} ({:.1}%); \
             files offered for removal before {}, now {}",
            counts.sets,
            counts.honoured_before,
            share(counts.honoured_before, counts.sets),
            counts.honoured_now,
            share(counts.honoured_now, counts.sets),
            counts.offered_before,
            counts.offered_now,
        );
    }
}

/// What the owner decided since a date, and removed copies still in holding, against the rule.
fn measure_held(connection: &Connection, since_ms: i64, threads: usize) {
    let count = |sql: &str| -> i64 {
        connection
            .query_row(sql, [since_ms], |row| row.get(0))
            .unwrap()
    };
    println!(
        "Since then: {} plain dismissals, {} from resolutions, {} resolutions applied",
        count(
            "SELECT COUNT(*) FROM duplicate_dismissals WHERE created_at >= ?1 AND plan_id IS NULL"
        ),
        count(
            "SELECT COUNT(*) FROM duplicate_dismissals WHERE created_at >= ?1
              AND plan_id IS NOT NULL"
        ),
        count(
            "SELECT COUNT(*) FROM plans WHERE created_at >= ?1 AND status = 'applied'
              AND kind = 'resolve-duplicates'"
        ),
    );
    let mut statement = connection
        .prepare(
            "SELECT h.hold_path FROM holding h JOIN plans p ON p.id = h.plan_id
              WHERE h.state = 'held' AND p.kind = 'resolve-duplicates' AND h.held_at >= ?1",
        )
        .unwrap();
    let held: Vec<String> = statement
        .query_map([since_ms], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut statement = connection
        .prepare(
            "SELECT r.path, f.rel_path, f.fingerprint, f.width, f.height FROM files f
              JOIN roots r ON r.id = f.root_id
              WHERE f.fingerprint LIKE 's:%' AND f.height > 0",
        )
        .unwrap();
    let stills: Vec<(PathBuf, u64, f64)> = statement
        .query_map([], |row| {
            let print: String = row.get(2)?;
            let width: f64 = row.get(3)?;
            let height: f64 = row.get(4)?;
            Ok((
                path_of(&row.get::<_, String>(0)?, &row.get::<_, String>(1)?),
                u64::from_str_radix(print.trim_start_matches("s:"), 16).unwrap_or(0),
                width / height,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let vips = open_libvips().unwrap();
    let (compared, called_copy) = (AtomicUsize::new(0), AtomicUsize::new(0));
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some(path) = held.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let path = Path::new(path);
                    let Ok(probe) = vips.probe(path) else {
                        continue;
                    };
                    let Some(removed) = measure_still(&vips, path) else {
                        continue;
                    };
                    let aspect = f64::from(probe.width) / f64::from(probe.height);
                    // The closest still left stands for the copy the owner kept.
                    let closest = stills
                        .iter()
                        .filter(|(_, _, other)| (other / aspect).ln().abs() <= 0.03)
                        .min_by_key(|(_, hash, _)| (hash ^ removed.hash).count_ones());
                    let Some((kept, hash, _)) = closest else {
                        continue;
                    };
                    let limit = still_threshold(SimilarityLevel::Balanced);
                    if (hash ^ removed.hash).count_ones() > limit {
                        continue;
                    }
                    let Some(kept) = measure_still(&vips, kept) else {
                        continue;
                    };
                    compared.fetch_add(1, Ordering::Relaxed);
                    let variant = is_variant(&removed.normal, &kept.normal)
                        || look_shows_variant(&removed.look, &kept.look);
                    called_copy.fetch_add(usize::from(!variant), Ordering::Relaxed);
                }
            });
        }
    });
    println!(
        "Removed copies still in holding: {}; compared with the closest still left {}; called \
         copies {}",
        held.len(),
        compared.load(Ordering::Relaxed),
        called_copy.load(Ordering::Relaxed),
    );
}

fn measure(catalog: &str, scratch: &Path, half: &str, threads: usize) {
    let connection = read_only(catalog);
    let since_ms = half.strip_prefix("since:").map(|date| {
        connection
            .query_row(
                "SELECT CAST(strftime('%s', ?1, 'utc') AS INTEGER) * 1000",
                [date],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap()
            .expect("a date like 2026-11-05")
    });
    let selection = Selection {
        half: match half {
            "train" => Some(0),
            "test" => Some(1),
            _ => None,
        },
        since_ms,
    };
    if since_ms.is_none() && !["train", "test", "all"].contains(&half) {
        panic!("{half} is not train, test, all or since:<date>");
    }
    let dismissal_of: HashMap<FileId, u8> = connection
        .prepare("SELECT file_id, dismissal_id FROM duplicate_dismissal_files")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, half_of(row.get(1)?))))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let pairs = scratch.join(format!("pairs-{}.tsv", half.replace(':', "-")));
    let _ = PAIRS.set(Mutex::new(std::fs::File::create(pairs).unwrap()));
    measure_dismissals(&connection, scratch, selection, threads);
    if let Some(since_ms) = since_ms {
        measure_held(&connection, since_ms, threads);
    } else {
        measure_copies(&connection, scratch, selection.half, threads, &dismissal_of);
        measure_video_copies(scratch, selection.half);
    }
}

/// How video copies are made, with Shrink's own settings for AV1: a name and ffmpeg's arguments.
const VIDEO_COPIES: &[(&str, &[&str])] = &[
    (
        "av1crf35",
        &["-c:v", "libsvtav1", "-preset", "6", "-crf", "35"],
    ),
    (
        "av1crf40",
        &["-c:v", "libsvtav1", "-preset", "6", "-crf", "40"],
    ),
    (
        "h264crf20",
        &["-c:v", "libx264", "-preset", "medium", "-crf", "20"],
    ),
    (
        "h264crf28",
        &["-c:v", "libx264", "-preset", "medium", "-crf", "28"],
    ),
    (
        "hevccrf24",
        &["-c:v", "libx265", "-preset", "medium", "-crf", "24"],
    ),
    (
        "fps24",
        &[
            "-vf", "fps=24", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        ],
    ),
    (
        "trim33",
        &[
            "-ss", "0.033", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        ],
    ),
    (
        "half",
        &[
            "-vf",
            "scale=trunc(iw/4)*2:trunc(ih/4)*2",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
        ],
    ),
];

/// One line per copy of a sample of videos under a minute: source id, half, kind and the five
/// frame distances, sorted. Goes on from where an earlier run stopped.
fn video_copies(catalog: &str, scratch: &Path, threads: usize, per_kind: usize) {
    let connection = read_only(catalog);
    let ffmpeg_at = PathBuf::from(ffmpeg_path());
    let half_of_dismissed: HashMap<FileId, u8> = connection
        .prepare("SELECT file_id, dismissal_id FROM duplicate_dismissal_files")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, half_of(row.get(1)?))))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let select = "SELECT f.id, r.path, f.rel_path, f.duration_ms, f.fingerprint FROM files f
      JOIN roots r ON r.id = f.root_id
      WHERE f.fingerprint LIKE 'm:%' AND f.duration_ms < 60000";
    let dismissed = "(SELECT file_id FROM duplicate_dismissal_files)";
    let mut sources: Vec<(FileId, PathBuf, f64, Fingerprint)> = Vec::new();
    for filter in ["IN", "NOT IN"] {
        let mut statement = connection
            .prepare(&format!("{select} AND f.id {filter} {dismissed}"))
            .unwrap();
        let mut rows: Vec<(FileId, PathBuf, f64, Fingerprint)> = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, FileId>(0)?,
                    path_of(&row.get::<_, String>(1)?, &row.get::<_, String>(2)?),
                    row.get::<_, f64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .filter_map(|(id, path, duration, print)| {
                Some((id, path, duration, Fingerprint::parse(&print)?))
            })
            .collect();
        rows.sort_by_key(|(id, ..)| (*id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        sources.extend(rows.into_iter().take(per_kind));
    }
    let folder = scratch.join("video-copies");
    std::fs::create_dir_all(&folder).unwrap();
    let results = scratch.join("video-copies.tsv");
    let done: HashSet<String> = std::fs::read_to_string(&results)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            Some(format!("{}:{}", fields.next()?, fields.nth(1)?))
        })
        .collect();
    type Source = (FileId, PathBuf, f64, Fingerprint);
    let jobs: Vec<(&Source, &(&str, &[&str]))> = sources
        .iter()
        .flat_map(|source| VIDEO_COPIES.iter().map(move |kind| (source, kind)))
        .filter(|((id, ..), (name, ..))| !done.contains(&format!("{id}:{name}")))
        .collect();
    let out = Mutex::new(
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&results)
            .unwrap(),
    );
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some(((id, path, duration, print), (name, arguments))) =
                    jobs.get(next.fetch_add(1, Ordering::Relaxed))
                {
                    let copy = folder.join(format!("{id}_{name}.mp4"));
                    let mut command =
                        vec![ffmpeg_path(), "-y", "-loglevel", "error", "-threads", "3"];
                    let input = path.to_string_lossy();
                    command.extend(["-i", &*input]);
                    command.extend(*arguments);
                    command.extend(["-an"]);
                    let copy_text = copy.to_string_lossy();
                    command.push(&copy_text);
                    let made = succeeded(&command);
                    let printed = made
                        .then(|| {
                            oriel_core_tidy::internals::fingerprint_video(
                                &ffmpeg_at, &copy, *duration,
                            )
                            .ok()
                        })
                        .flatten();
                    let _ = std::fs::remove_file(&copy);
                    let (
                        Some(Fingerprint::Motion { frames, .. }),
                        Fingerprint::Motion {
                            frames: original, ..
                        },
                    ) = (printed, print)
                    else {
                        continue;
                    };
                    let mut distances: Vec<u32> = frames
                        .iter()
                        .zip(original)
                        .map(|(left, right)| left.distance(*right))
                        .collect();
                    distances.sort_unstable();
                    let half = half_of_dismissed
                        .get(id)
                        .copied()
                        .unwrap_or_else(|| half_of(*id));
                    writeln!(
                        out.lock().unwrap(),
                        "{id}\t{half}\t{name}\t{}",
                        distances
                            .iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                    .unwrap();
                }
            });
        }
    });
    let _ = std::fs::remove_dir_all(&folder);
    println!("{} video copies measured", jobs.len());
}

/// Video copies measured by `video-copies` in one half: how many the frames still call copies.
fn measure_video_copies(scratch: &Path, half: Option<u8>) {
    let Ok(lines) = std::fs::read_to_string(scratch.join("video-copies.tsv")) else {
        return;
    };
    let mut kinds: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for line in lines.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let [_, in_half, kind, distances] = fields[..] else {
            continue;
        };
        if half.is_some_and(|half| Ok(half) != in_half.parse()) {
            continue;
        }
        let distances: Vec<u32> = distances
            .split(',')
            .filter_map(|bits| bits.parse().ok())
            .collect();
        let counts = kinds.entry(kind.to_owned()).or_default();
        counts.0 += 1;
        // A resized copy differs in size, so its frames are not compared.
        counts.1 += usize::from(kind != "half" && frames_show_variant(&distances));
    }
    println!("\nGenerated video copies (still copies, now; every one was before)");
    let (mut all, mut variants) = (0, 0);
    for (kind, (total, called_variant)) in &kinds {
        all += total;
        variants += called_variant;
        println!(
            "  {kind:<20} {total:>4} pairs  {:>4} ({:>5.1}%)",
            total - called_variant,
            share(total - called_variant, *total)
        );
    }
    println!(
        "  all {all} pairs: {} ({:.1}%)",
        all - variants,
        share(all - variants, all)
    );
}

/// CPU seconds this process has used, so a phase's cost can be told from what else the machine
/// was doing at the time. Off Unix it reads nothing.
#[cfg(unix)]
fn cpu_seconds() -> f64 {
    // SAFETY: getrusage fills the struct it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let seconds = |time: libc::timeval| time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

#[cfg(not(unix))]
fn cpu_seconds() -> f64 {
    0.0
}

/// The phase running, when it started, and the CPU used by then.
struct Timing(Mutex<(String, Instant, f64)>);

impl Progress for Timing {
    fn phase(&self, label: &str, total: u64) {
        let mut phase = self.0.lock().unwrap();
        println!(
            "  {:>7.1} s wall {:>8.1} s CPU  {}",
            phase.1.elapsed().as_secs_f64(),
            cpu_seconds() - phase.2,
            phase.0
        );
        *phase = (format!("{label} ({total})"), Instant::now(), cpu_seconds());
    }

    fn done(&self, _done: u64) {}

    fn cancel_token(&self) -> Option<&CancelToken> {
        None
    }
}

/// Each open set in queue order: its key, kind, files, what it keeps and frees, whether it is
/// video, its versions, how many of them share their size with another, and its file ids. Ids and
/// counts only.
fn dump_sets(engine: &TidyEngine, root: i64, out: &Path) {
    let mut lines = String::new();
    for (scope, name) in [
        (DuplicateScope::Similar, "similar"),
        (DuplicateScope::Variants, "variants"),
    ] {
        let page = block_on(engine.duplicate_sets(DuplicateSetRequest {
            root_id: Some(root),
            offset: 0,
            limit: 1_000_000,
            level: SimilarityLevel::Balanced,
            scope,
            dismissed: false,
        }))
        .unwrap();
        for set in &page.sets {
            let files: usize = set.versions.iter().map(|version| version.files.len()).sum();
            let video = set
                .versions
                .iter()
                .flat_map(|version| &version.files)
                .any(|file| file.duration_ms.is_some());
            let sizes: Vec<_> = set
                .versions
                .iter()
                .filter_map(|version| version.files.first())
                .map(|file| (file.width, file.height))
                .collect();
            let shared = sizes
                .iter()
                .filter(|size| sizes.iter().filter(|other| other == size).count() > 1)
                .count();
            let ids: Vec<String> = set
                .versions
                .iter()
                .flat_map(|version| &version.files)
                .map(|file| file.id.to_string())
                .collect();
            lines += &format!(
                "{}\t{name}\t{files}\t{}\t{}\t{}\t{}\t{shared}\t{}\n",
                set.key,
                set.keep.len(),
                set.reclaimable_bytes,
                u8::from(video),
                sizes.len(),
                ids.join(","),
            );
        }
    }
    std::fs::write(out, lines).unwrap();
}

/// How close the pairs a closer look left as copies of one size came to being called variants,
/// and which set each is in, for reading against the queue. Numbers only.
fn margins(catalog: &Path, out: &Path) {
    let connection = read_only(&catalog.to_string_lossy());
    let mut statement = connection
        .prepare(
            "SELECT c.left_id, c.right_id, rl.path, l.rel_path, rr.path, r.rel_path
              FROM file_comparisons c
              JOIN files l ON l.id = c.left_id JOIN roots rl ON rl.id = l.root_id
              JOIN files r ON r.id = c.right_id JOIN roots rr ON rr.id = r.root_id
              WHERE c.variant = 0 AND l.width = r.width AND l.height = r.height",
        )
        .unwrap();
    let pairs: Vec<(FileId, FileId, PathBuf, PathBuf)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                path_of(&row.get::<_, String>(2)?, &row.get::<_, String>(3)?),
                path_of(&row.get::<_, String>(4)?, &row.get::<_, String>(5)?),
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let vips = open_libvips().unwrap();
    let lines = Mutex::new(String::new());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..10 {
            scope.spawn(|| {
                while let Some((left, right, left_path, right_path)) =
                    pairs.get(next.fetch_add(1, Ordering::Relaxed))
                {
                    let (Ok(left_look), Ok(right_look)) = (
                        look_at_still(&vips, left_path),
                        look_at_still(&vips, right_path),
                    ) else {
                        continue;
                    };
                    let print = detail_difference(
                        &normalize_detail(&left_look.print()),
                        &normalize_detail(&right_look.print()),
                    );
                    let look = look_measures(&left_look, &right_look);
                    lines.lock().unwrap().push_str(&format!(
                        "{left}\t{right}\t{:.3}\t{:.3}\t{:.3}\t{:.4}\t{:.3}\n",
                        print.local, print.typical, look.spot, look.matching, look.colour_shift
                    ));
                }
                oriel_runtime::release_free_memory();
            });
        }
    });
    std::fs::write(out, lines.into_inner().unwrap()).unwrap();
}

/// The open sets on a copy of the catalog after an analysis with this code: how many of each kind,
/// the bytes their suggestions free, the time it took and what it added to the catalog.
fn library(catalog: &str, scratch: &Path) {
    let folder = scratch.join("library");
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).unwrap();
    let copy = folder.join("catalog.sqlite");
    read_only(catalog)
        .execute_batch(&format!("VACUUM INTO '{}'", copy.display()))
        .unwrap();
    // Opened, the engine recovers a change that was under way, removing its temp files beside the
    // owner's own files. The owner's app may be running that change: the copy leaves it alone.
    Connection::open(&copy)
        .unwrap()
        .execute(
            "UPDATE plans SET status = 'cancelled' WHERE status = 'applying'",
            [],
        )
        .unwrap();
    let size_before = std::fs::metadata(&copy).unwrap().len();
    let data = DataRoot::at(folder.clone()).unwrap();
    let engine = block_on(TidyEngine::open_with(data, copy.clone(), Media::locate())).unwrap();
    let roots = block_on(engine.roots()).unwrap();
    let mut settings = block_on(engine.settings()).unwrap();
    settings.spot_variants = true;
    settings.similarity = SimilarityLevel::Balanced;
    block_on(engine.update_settings(settings)).unwrap();

    let started = Instant::now();
    for root in &roots {
        println!("Analysis, phase by phase:");
        let timing = Timing(Mutex::new((
            "starting".to_owned(),
            Instant::now(),
            cpu_seconds(),
        )));
        let report = engine
            .analyze(root.id, AnalysisKind::AskedFor)
            .run(&timing)
            .unwrap();
        timing.phase("end", 0);
        println!("  stills offered: {}", report.detail_candidates);
    }
    println!("Analysis in all: {:.1} s", started.elapsed().as_secs_f64());

    for root in &roots {
        let page = block_on(engine.duplicate_sets(DuplicateSetRequest {
            root_id: Some(root.id),
            offset: 0,
            limit: 1_000_000,
            level: SimilarityLevel::Balanced,
            scope: DuplicateScope::All,
            dismissed: false,
        }))
        .unwrap();
        let similar_with_copy = page
            .sets
            .iter()
            .filter(|set| set.kind == DuplicateKind::Similar)
            .count();
        println!(
            "Open sets: identical {}, similar with a copy {similar_with_copy} (counted {}), \
             all variants {}, dismissed {}",
            page.counts.exact, page.counts.similar, page.counts.variants, page.counts.dismissed
        );
        println!(
            "Suggestions free {:.2} GB; compared {} of {} stills",
            page.open_reclaimable_bytes as f64 / 1e9,
            page.compared,
            page.comparable
        );
    }

    for root in &roots {
        dump_sets(&engine, root.id, &scratch.join("sets-now.tsv"));
    }
    margins(&copy, &scratch.join("margins.tsv"));
    let started = Instant::now();
    drop(engine);
    let connection = Connection::open(&copy).unwrap();
    connection.execute_batch("VACUUM").unwrap();
    let count = |sql: &str| -> i64 { connection.query_row(sql, [], |row| row.get(0)).unwrap() };
    println!(
        "Catalog: {size_before} bytes before, {} after; {} prints, {} comparisons, \
         {} say variant ({:.1} s to compact)",
        std::fs::metadata(&copy).unwrap().len(),
        count("SELECT COUNT(*) FROM file_details WHERE print IS NOT NULL"),
        count("SELECT COUNT(*) FROM file_comparisons"),
        count("SELECT COUNT(*) FROM file_comparisons WHERE variant = 1"),
        started.elapsed().as_secs_f64(),
    );
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let usage = "dup_precision copies|video-copies|measure|library <catalog> <scratch> ...";
    let (command, catalog, scratch) = match &arguments[..] {
        [command, catalog, scratch, ..] => (command.as_str(), catalog, Path::new(scratch)),
        _ => panic!("{usage}"),
    };
    let number = |index: usize, default: usize| {
        arguments
            .get(index)
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    std::fs::create_dir_all(scratch).unwrap();
    match command {
        "copies" => generate(catalog, scratch, number(3, 10), number(4, 80)),
        "measure" => measure(catalog, scratch, &arguments[3], number(4, 10)),
        "library" => library(catalog, scratch),
        "video-copies" => video_copies(catalog, scratch, number(3, 6), number(4, 16)),
        _ => panic!("{usage}"),
    }
}
