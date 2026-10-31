//! Checks `animation-mp4.ts`'s decisions against `conformance/media-format/animation-mp4.json`,
//! which records what the real function painted and handed its encoder for each animation.

mod support;

use oriel_core_format::{
    ANIMATION_BACKGROUND, ANIMATION_MP4_SETTINGS, AnimatedImageMimeType, animation_canvas_size,
    plan_animation_frames,
};
use serde::Deserialize;
use serde_json::Value;
use support::{check, fail_with, json, read_vectors};

#[derive(Deserialize)]
struct AnimationVectors {
    settings: Value,
    cases: Vec<AnimationCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnimationCase {
    about: String,
    // Every format follows the same decisions; the field is read to check it parses.
    #[allow(dead_code)]
    mime_type: AnimatedImageMimeType,
    width: u64,
    height: u64,
    durations: Vec<Option<u64>>,
    recorded: Recorded,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recorded {
    canvas: Option<Size>,
    context_options: Option<ContextOptions>,
    fills: Vec<Fill>,
    draws: Vec<Draw>,
    frames: Vec<Frame>,
    finalized: bool,
}

#[derive(Debug, PartialEq, Deserialize)]
struct Size {
    width: u64,
    height: u64,
}

#[derive(Deserialize)]
struct ContextOptions {
    #[serde(rename = "type")]
    kind: String,
    alpha: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fill {
    fill_style: String,
    rect: Vec<u64>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draw {
    frame_index: usize,
    x: u64,
    y: u64,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    timestamp_seconds: f64,
    duration_seconds: f64,
    key_frame: bool,
}

/// A CSS colour as the TypeScript writes it, `#rgb` or `#rrggbb`, as RGB.
fn parse_colour(colour: &str) -> Option<[u8; 3]> {
    let hex = colour.strip_prefix('#')?;
    let channel = |digits: &str| u8::from_str_radix(digits, 16).ok();
    match hex.len() {
        3 => {
            let mut rgb = [0; 3];
            for (index, digit) in hex.char_indices() {
                rgb[index] = channel(&format!("{digit}{digit}"))?;
            }
            Some(rgb)
        }
        6 => Some([
            channel(&hex[0..2])?,
            channel(&hex[2..4])?,
            channel(&hex[4..6])?,
        ]),
        _ => None,
    }
}

#[test]
fn converts_with_the_settings_the_typescript_uses() {
    let vectors: AnimationVectors = read_vectors("animation-mp4.json");
    assert_eq!(vectors.settings, json(&ANIMATION_MP4_SETTINGS));
}

#[test]
fn sizes_paints_and_times_frames_as_the_typescript_does() {
    let vectors: AnimationVectors = read_vectors("animation-mp4.json");
    let mut problems = Vec::new();
    for case in &vectors.cases {
        let about = || case.about.clone();
        let recorded = &case.recorded;
        let planned = plan_animation_frames(case.durations.iter().copied());

        match (&case.error, planned) {
            (Some(typescript), Err(rust)) => {
                check(&mut problems, about, typescript, &rust.to_string());
                check(&mut problems, about, &None, &recorded.canvas);
            }
            (Some(typescript), Ok(_)) => {
                problems.push(format!(
                    "{}: the TypeScript fails with {typescript:?}",
                    about()
                ));
            }
            (None, Err(rust)) => problems.push(format!("{}: Rust fails with {rust}", about())),
            (None, Ok(frames)) => {
                let (width, height) = animation_canvas_size(case.width, case.height);
                check(
                    &mut problems,
                    || format!("{}: the canvas", about()),
                    &recorded.canvas,
                    &Some(Size { width, height }),
                );
                // An opaque 2D canvas is what discarding alpha means on the Mediabunny path.
                if let Some(context) = &recorded.context_options {
                    check(
                        &mut problems,
                        || format!("{}: an opaque 2D canvas", about()),
                        &(context.kind.as_str(), context.alpha),
                        &("2d", ANIMATION_MP4_SETTINGS.alpha != "discard"),
                    );
                }
                for fill in &recorded.fills {
                    check(
                        &mut problems,
                        || format!("{}: each frame's background", about()),
                        &(parse_colour(&fill.fill_style), fill.rect.as_slice()),
                        &(Some(ANIMATION_BACKGROUND), [0, 0, width, height].as_slice()),
                    );
                }
                let draws: Vec<Draw> = (0..frames.len())
                    .map(|frame_index| Draw {
                        frame_index,
                        x: 0,
                        y: 0,
                    })
                    .collect();
                check(
                    &mut problems,
                    || format!("{}: frames drawn at the top left", about()),
                    &recorded.draws,
                    &draws,
                );
                let frames: Vec<Frame> = frames
                    .iter()
                    .map(|frame| Frame {
                        timestamp_seconds: frame.timestamp_seconds(),
                        duration_seconds: frame.duration_seconds(),
                        key_frame: frame.key_frame,
                    })
                    .collect();
                check(
                    &mut problems,
                    || format!("{}: frame times", about()),
                    &recorded.frames,
                    &frames,
                );
                check(&mut problems, about, &true, &recorded.finalized);
            }
        }
    }
    fail_with(&problems, "animations differ");
}
