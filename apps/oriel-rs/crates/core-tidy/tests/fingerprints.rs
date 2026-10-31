//! Fingerprint parity with glazier-core (plan 063): Spot variants' thresholds were measured on
//! prints glazier-core made, so the prints made here must equal them bit for bit. The vectors are
//! what glazier-core makes of the corpus; `fingerprint-vectors.test.ts` keeps them current.

mod support;

use std::path::Path;

use oriel_core_tidy::media::probe_video;
use oriel_core_tidy::similarity::{
    Fingerprint, Hash64, Vips, accepts_libvips_version, animation_frame_times, detail_of_still,
    fingerprint_animation, fingerprint_still, fingerprint_video, frame_run_pixels, is_variant,
    normalize_detail, perceptual_hash, plan_frame_runs, video_frame_pixels,
};
use support::{
    ProbeVector, corpus_dir, from_hex, has_ffmpeg, libvips_path, vectors, write_large_png,
};

fn probe_of(vips: &Vips, path: &Path) -> ProbeVector {
    let probe = vips.probe(path).expect("a probe");
    ProbeVector {
        width: probe.width,
        height: probe.height,
        frames: probe.frames,
        has_alpha: probe.has_alpha,
        frame_delays_ms: probe.frame_delays_ms,
    }
}

fn vips() -> Vips {
    let path = libvips_path();
    let vips = Vips::open(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let made_with = vectors().libvips;
    // Any 8.18 release prints the same (the owner's decision of 2026-10-29); the vectors say
    // which one made them.
    assert!(
        accepts_libvips_version(&vips.version()) && accepts_libvips_version(&made_with),
        "The vectors were made with libvips {made_with}, and {} is {}; fingerprints match only \
         with sharp's 8.18 line.",
        path.display(),
        vips.version()
    );
    vips
}

/// What differs between the prints made here and the vector's, if anything.
fn compare_still(
    vips: &Vips,
    path: &Path,
    name: &str,
    expected: (&str, &str, &str),
) -> Option<String> {
    let (fingerprint, grey32, detail) = expected;
    let mut problems = Vec::new();
    match vips.grey_pixels(path, 32, None) {
        Ok(pixels) if pixels != from_hex(grey32) => problems.push("32×32 grey pixels differ"),
        Ok(_) => {}
        Err(error) => return Some(format!("{name}: {error}")),
    }
    match fingerprint_still(vips, path) {
        Ok(made) if made.to_string() != fingerprint => problems.push("fingerprint differs"),
        Ok(_) => {}
        Err(error) => return Some(format!("{name}: {error}")),
    }
    match detail_of_still(vips, path) {
        Ok(made) if made != from_hex(detail) => problems.push("detail print differs"),
        Ok(_) => {}
        Err(error) => return Some(format!("{name}: {error}")),
    }
    (!problems.is_empty()).then(|| format!("{name}: {}", problems.join(", ")))
}

#[test]
fn the_hash_matches_on_synthetic_pixels() {
    for vector in vectors().phash {
        let hash = perceptual_hash(&from_hex(&vector.pixels)).expect("32×32 pixels");
        assert_eq!(hash.to_string(), vector.hash, "pHash of {}", vector.name);
    }
}

#[test]
fn the_hash_of_glazier_cores_pixels_is_its_fingerprint() {
    for still in vectors().stills {
        let hash = perceptual_hash(&from_hex(&still.grey32)).expect("32×32 pixels");
        assert_eq!(format!("s:{hash}"), still.fingerprint, "{}", still.file);
    }
}

#[test]
fn stills_print_bit_for_bit() {
    let vips = vips();
    let differences: Vec<String> = vectors()
        .stills
        .iter()
        .filter_map(|still| {
            let expected = (
                still.fingerprint.as_str(),
                still.grey32.as_str(),
                still.detail.as_str(),
            );
            compare_still(
                &vips,
                &corpus_dir().join(&still.file),
                &still.file,
                expected,
            )
        })
        .collect();
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[test]
fn stills_probe_as_glazier_core_probes_them() {
    let vips = vips();
    for still in vectors().stills {
        let probe = probe_of(&vips, &corpus_dir().join(&still.file));
        assert_eq!(probe, still.probe, "{}", still.file);
    }
}

#[test]
fn a_large_drawn_still_prints_bit_for_bit() {
    let vips = vips();
    let scratch = support::Scratch::new("oriel-core-tidy-large");
    for drawn in vectors().drawn {
        let path = write_large_png(&scratch.0, &drawn);
        let expected = (
            drawn.fingerprint.as_str(),
            drawn.grey32.as_str(),
            drawn.detail.as_str(),
        );
        assert_eq!(compare_still(&vips, &path, &drawn.name, expected), None);
    }
}

#[test]
fn animations_sample_and_print_bit_for_bit() {
    let vips = vips();
    for animation in vectors().animations {
        let path = corpus_dir().join(&animation.file);
        let probe = probe_of(&vips, &path);
        assert_eq!(probe, animation.probe, "{}", animation.file);
        let times = animation_frame_times(&probe.frame_delays_ms, probe.frames);
        assert_eq!(times, animation.frame_times_ms, "{}", animation.file);
        let made = fingerprint_animation(&vips, &path, &times).expect("a fingerprint");
        assert_eq!(
            made.to_string(),
            animation.fingerprint,
            "{}",
            animation.file
        );
    }
}

#[test]
fn videos_print_bit_for_bit_through_the_same_ffmpeg() {
    if !has_ffmpeg() {
        eprintln!("No ffmpeg on PATH; the video vectors were not checked.");
        return;
    }
    for video in vectors().videos {
        let made = fingerprint_video(
            Path::new("ffmpeg"),
            &corpus_dir().join(&video.file),
            video.duration_ms,
        )
        .expect("a fingerprint");
        assert_eq!(made.to_string(), video.fingerprint, "{}", video.file);
    }
}

#[test]
fn pairs_compare_as_glazier_core_compares_them() {
    let vectors = vectors();
    let still = |file: &str| {
        vectors
            .stills
            .iter()
            .find(|still| still.file == file)
            .unwrap_or_else(|| panic!("{file} is not in the corpus"))
    };
    let hash = |file: &str| match Fingerprint::parse(&still(file).fingerprint) {
        Some(Fingerprint::Still(hash)) => hash,
        _ => panic!("{file} has no still fingerprint"),
    };
    for pair in &vectors.pairs {
        let distance = Hash64::distance(hash(&pair.left), hash(&pair.right));
        assert_eq!(distance, pair.distance, "{} and {}", pair.left, pair.right);
        let variant = is_variant(
            &normalize_detail(&from_hex(&still(&pair.left).detail)),
            &normalize_detail(&from_hex(&still(&pair.right).detail)),
        );
        assert_eq!(variant, pair.variant, "{} and {}", pair.left, pair.right);
    }
}

#[test]
fn a_run_of_samples_makes_the_bytes_their_single_runs_make() {
    // The pinned ffmpeg and ffprobe, as the fingerprint pass runs them, on the videos of the
    // archive the differential runs scan and on the corpus clip.
    let media = oriel_core_tidy::passes::Media::locate();
    let (Some(ffmpeg), Some(ffprobe)) = (media.ffmpeg.as_deref(), media.ffprobe.as_deref()) else {
        eprintln!("No pinned ffmpeg and ffprobe; the runs of samples were not checked.");
        return;
    };
    let clips =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core/archive");
    let mut videos: Vec<_> = std::fs::read_dir(clips.join("clips"))
        .unwrap()
        .chain(std::fs::read_dir(clips.join("dup")).unwrap())
        .map(|entry| entry.unwrap().path())
        .chain([corpus_dir().join("clip.mp4")])
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ["mp4", "mov", "webm"].contains(&ext.to_str().unwrap()))
        })
        .collect();
    videos.sort();
    let mut compared = 0;
    for path in &videos {
        let duration_ms = probe_video(ffprobe, path, None)
            .unwrap()
            .duration_ms
            .unwrap();
        for run in plan_frame_runs(ffprobe, path, duration_ms, None).unwrap() {
            if run.positions().len() < 2 {
                continue;
            }
            let frames = frame_run_pixels(ffmpeg, path, &run, None)
                .unwrap()
                .unwrap_or_else(|| panic!("{}: the run of {:?} failed", path.display(), run));
            for (frame, &seconds) in frames.iter().zip(run.seconds()) {
                let single = video_frame_pixels(ffmpeg, path, seconds, None).unwrap();
                assert_eq!(frame, &single, "{} at {seconds} s", path.display());
                compared += 1;
            }
        }
    }
    // Six MP4 and QuickTime clips share one run of five, and one has a keyframe in the middle.
    assert!(
        compared >= 30,
        "only {compared} frames came from runs of samples"
    );
}
