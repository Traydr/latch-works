//! Media GPUI does not handle itself: AVIF and HEIC stills (GPUI's decoder has neither) and video
//! (GPUI has no video element). See plan 063, "Media in GPUI".

pub mod still;
pub mod video;
