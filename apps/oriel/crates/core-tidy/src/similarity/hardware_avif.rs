//! Plain AVIF stills through the Mac's hardware AV1 decoder, for the pixels prints are made from;
//! closer looks read through libvips. AV1's decoding is exact, so the hardware's planes are aom's
//! bytes, and turning them to RGB as libheif does gives what libvips' loader gives, at a fraction
//! of its CPU.
//!
//! Stored prints depend on those bytes, so this only takes a file it can be sure of: one AV1 picture
//! at 8 bits and 4:2:0, in full range and BT.601, with no film grain and no alpha, turn, mirror
//! or crop, beside nothing but Exif and XMP. Anything else is [`Declined`], and libvips reads it as
//! it always has, as it does on any Mac without the decoder. libvips has already read the file's
//! header by then, and what it found there (an orientation, a profile) applies to these pixels too.

use std::ffi::c_void;
use std::fs::File;
use std::os::unix::fs::FileExt as _;
use std::path::Path;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, mpsc};
use std::time::Duration;

/// A still as 8-bit RGB, rows packed top to bottom.
#[derive(Debug)]
pub struct HardwareStill {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// Why a file is left to libvips.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Declined {
    /// This Mac has no hardware AV1 decoder.
    NoDecoder,
    /// It could not be read, or it is not an AVIF.
    NotAvif,
    /// Boxes this does not know, a sequence, or several extents.
    Container,
    /// Another picture beside this one: alpha, a grid, a thumbnail.
    OtherItems,
    /// A property that changes the pixels: a turn, a mirror, a crop.
    Properties,
    /// Not full range, or not BT.601.
    Colour,
    /// Not 8-bit 4:2:0, by the AV1 configuration or the sequence header.
    Format,
    /// Film grain, or a sequence header this does not read.
    Sequence,
    /// The decoder refused it, or gave another size than the file states.
    Decoder,
}

/// The one matrix the route takes, BT.601: the only one in the library it was checked on.
const MATRIX_BT601: u16 = 6;

/// libheif's fixed-point coefficients for it at 8 bits, as `lround(256 × coefficient)`: red from Cr,
/// green from Cb and from Cr, blue from Cb.
const COEFFICIENTS: [i32; 4] = [359, -88, -183, 454];

/// How long the decoder may take over one still before libvips reads it instead.
const DECODE_LIMIT: Duration = Duration::from_secs(10);

/// The most a container's `ftyp` and `meta` boxes may hold: far past any picture's profile and
/// properties, and bytes read before anything says this is a file to read.
const MOST_HEADER_BYTES: u64 = 16 << 20;

/// A decode outlived [`DECODE_LIMIT`]: a decoder that hung once is not asked again.
static HUNG: AtomicBool = AtomicBool::new(false);

/// The still at `path` through the hardware decoder, or why it is left to libvips.
pub fn decode(path: &Path) -> Result<HardwareStill, Declined> {
    if !decoder_present() {
        return Err(Declined::NoDecoder);
    }
    let file = File::open(path).map_err(|_| Declined::NotAvif)?;
    let length = file.metadata().map_err(|_| Declined::NotAvif)?.len();
    let (ftyp, meta) = read_top_boxes(length, |offset, bytes| file.read_exact_at(bytes, offset))?;
    let item = read_container(&ftyp, &meta)?;
    let end = item.offset.saturating_add(item.length);
    if end as u64 > length {
        return Err(Declined::Container);
    }
    let mut data = vec![0; item.length];
    file.read_exact_at(&mut data, item.offset as u64)
        .map_err(|_| Declined::Container)?;
    let sequence = read_sequence_header(&data)?;
    // libheif takes the container's colour, or else what the AV1 says.
    let (matrix, full_range) = item.colour.unwrap_or(sequence);
    if !full_range || matrix != MATRIX_BT601 {
        return Err(Declined::Colour);
    }
    match within(DECODE_LIMIT, move || decode_planes(&item, &data)) {
        Some(still) => still,
        None => {
            log::warn!("the hardware AV1 decoder did not answer; libvips reads from here on");
            HUNG.store(true, Ordering::Release);
            Err(Declined::Decoder)
        }
    }
}

/// `work`'s answer, or `None` once `limit` has passed. Nothing can stop a decoder that hangs, so
/// its thread is left behind, holding what it was given, while the caller goes on.
fn within<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (answer, answered) = mpsc::channel();
    std::thread::Builder::new()
        .name("hardware avif".into())
        .spawn(move || {
            let _ = answer.send(work());
        })
        .ok()?;
    answered.recv_timeout(limit).ok()
}

/// Whether this Mac decodes AV1 in hardware, and its decoder has not hung; asked of it once.
fn decoder_present() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    // SAFETY: takes a codec type and has no other preconditions.
    *SUPPORTED.get_or_init(|| unsafe { VTIsHardwareDecodeSupported(CODEC_AV1) } != 0)
        && !HUNG.load(Ordering::Acquire)
}

/// What the container says about its one picture.
#[derive(Default)]
struct Item {
    configuration: Vec<u8>,
    width: u32,
    height: u32,
    /// The container's matrix and range, when it states them.
    colour: Option<(u16, bool)>,
    offset: usize,
    length: usize,
}

/// The boxes of a run of bytes as (type, body).
fn boxes(mut bytes: &[u8]) -> impl Iterator<Item = Result<(&[u8; 4], &[u8]), Declined>> {
    std::iter::from_fn(move || {
        if bytes.is_empty() {
            return None;
        }
        let parsed = (|| {
            let size = u32::from_be_bytes(*bytes.first_chunk()?) as usize;
            let kind = bytes.get(4..8)?.first_chunk::<4>()?;
            let (start, end) = match size {
                0 => (8, bytes.len()),
                1 => (
                    16,
                    usize::try_from(u64::from_be_bytes(*bytes.get(8..16)?.first_chunk()?)).ok()?,
                ),
                size => (8, size),
            };
            let body = bytes.get(start..end)?;
            let rest = bytes.get(end..)?;
            Some((kind, body, rest))
        })();
        match parsed {
            Some((kind, body, rest)) => {
                bytes = rest;
                Some(Ok((kind, body)))
            }
            None => {
                bytes = &[];
                Some(Err(Declined::Container))
            }
        }
    })
}

/// A big-endian reader that fails rather than reads past its end.
struct Fields<'a>(&'a [u8]);

impl<'a> Fields<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Declined> {
        let (taken, rest) = self.0.split_at_checked(count).ok_or(Declined::Container)?;
        self.0 = rest;
        Ok(taken)
    }

    /// A number of `width` bytes, at most 8.
    fn number(&mut self, width: usize) -> Result<u64, Declined> {
        Ok(self
            .take(width)?
            .iter()
            .fold(0, |value, &byte| (value << 8) | u64::from(byte)))
    }
}

/// Walks the file's top-level boxes by their headers alone and reads only `ftyp` and `meta`,
/// declining anything else there is. Nothing of the coded data is read yet, so a file this declines
/// costs a few small reads. `read` fills its bytes from an offset into the file.
fn read_top_boxes(
    length: u64,
    read: impl Fn(u64, &mut [u8]) -> std::io::Result<()>,
) -> Result<(Vec<u8>, Vec<u8>), Declined> {
    let (mut ftyp, mut meta) = (None, None);
    let mut at = 0u64;
    while at < length {
        let mut head = [0u8; 16];
        let have = (length - at).min(16) as usize;
        if have < 8 {
            return Err(Declined::Container);
        }
        read(at, &mut head[..have]).map_err(|_| Declined::NotAvif)?;
        let size = u64::from(u32::from_be_bytes([head[0], head[1], head[2], head[3]]));
        let (start, end) = match size {
            0 => (at + 8, length),
            1 if have == 16 => (
                at + 16,
                at.checked_add(u64::from_be_bytes([
                    head[8], head[9], head[10], head[11], head[12], head[13], head[14], head[15],
                ]))
                .ok_or(Declined::Container)?,
            ),
            1 => return Err(Declined::Container),
            size => (at + 8, at + size),
        };
        if end < start || end > length {
            return Err(Declined::Container);
        }
        let body = || -> Result<Vec<u8>, Declined> {
            if end - start > MOST_HEADER_BYTES {
                return Err(Declined::Container);
            }
            let mut bytes = vec![0; (end - start) as usize];
            read(start, &mut bytes).map_err(|_| Declined::NotAvif)?;
            Ok(bytes)
        };
        match (&head[4..8], at) {
            (b"ftyp", 0) => ftyp = Some(body()?),
            (_, 0) => return Err(Declined::NotAvif),
            (b"meta", _) if meta.is_none() => meta = Some(body()?),
            (b"mdat" | b"free" | b"skip", _) => {}
            _ => return Err(Declined::Container),
        }
        at = end;
    }
    Ok((
        ftyp.ok_or(Declined::NotAvif)?,
        meta.ok_or(Declined::Container)?,
    ))
}

/// Reads the `ftyp` and `meta` boxes, and declines anything but one AV1 picture.
fn read_container(ftyp: &[u8], meta: &[u8]) -> Result<Item, Declined> {
    let brands = ftyp.get(8..).ok_or(Declined::Container)?;
    let major = ftyp.get(..4).ok_or(Declined::Container)?;
    let named = |brand: &[u8; 4]| {
        major == brand || brands.as_chunks::<4>().0.iter().any(|name| name == brand)
    };
    if !named(b"avif") || named(b"avis") {
        return Err(Declined::NotAvif);
    }
    let meta = meta.get(4..).ok_or(Declined::Container)?;

    let mut primary = None;
    let mut location = None;
    let mut picture = None;
    let mut properties = None;
    for found in boxes(meta) {
        let (kind, body) = found?;
        match kind {
            b"hdlr" => {
                if body.get(8..12) != Some(b"pict") {
                    return Err(Declined::Container);
                }
            }
            b"dinf" | b"free" | b"skip" => {}
            b"pitm" => primary = Some(read_primary(body)?),
            b"iinf" => picture = Some(read_items(body)?),
            b"iloc" => location = Some(body),
            b"iprp" => properties = Some(body),
            b"iref" => {
                for reference in boxes(body.get(4..).ok_or(Declined::Container)?) {
                    // Exif and XMP describe the picture; anything else makes one out of others.
                    if reference?.0 != b"cdsc" {
                        return Err(Declined::OtherItems);
                    }
                }
            }
            b"grpl" => return Err(Declined::OtherItems),
            _ => return Err(Declined::Container),
        }
    }
    let primary = primary.ok_or(Declined::Container)?;
    if picture != Some(primary) {
        return Err(Declined::OtherItems);
    }
    let mut item = read_properties(properties.ok_or(Declined::Container)?, primary)?;
    (item.offset, item.length) = read_location(location.ok_or(Declined::Container)?, primary)?;
    Ok(item)
}

fn read_primary(body: &[u8]) -> Result<u32, Declined> {
    let mut fields = Fields(body);
    let version = fields.number(4)? >> 24;
    Ok(fields.number(if version == 0 { 2 } else { 4 })? as u32)
}

/// The id of the file's only picture, which is AV1 and not hidden, with at most Exif and XMP beside
/// it; declines any other.
fn read_items(body: &[u8]) -> Result<u32, Declined> {
    let mut fields = Fields(body);
    let version = fields.number(4)? >> 24;
    fields.number(if version == 0 { 2 } else { 4 })?;
    let mut picture = None;
    for found in boxes(fields.0) {
        let (kind, entry) = found?;
        if kind != b"infe" {
            return Err(Declined::Container);
        }
        let mut entry = Fields(entry);
        let head = entry.number(4)?;
        let (version, flags) = (head >> 24, head & 0xff_ffff);
        let id = match version {
            2 => entry.number(2)?,
            3 => entry.number(4)?,
            _ => return Err(Declined::Container),
        };
        entry.number(2)?;
        match entry.take(4)? {
            b"av01" if picture.is_none() && flags & 1 == 0 => picture = Some(id as u32),
            b"Exif" | b"mime" => {}
            _ => return Err(Declined::OtherItems),
        }
    }
    picture.ok_or(Declined::OtherItems)
}

/// The primary item's properties: only those that change no pixel, all of them known.
fn read_properties(body: &[u8], primary: u32) -> Result<Item, Declined> {
    let mut held = Vec::new();
    let mut associations = None;
    for found in boxes(body) {
        let (kind, inner) = found?;
        match kind {
            b"ipco" => {
                for property in boxes(inner) {
                    held.push(property?);
                }
            }
            b"ipma" if associations.is_none() => associations = Some(inner),
            _ => return Err(Declined::Container),
        }
    }
    let mut fields = Fields(associations.ok_or(Declined::Container)?);
    let head = fields.number(4)?;
    let (version, wide_index) = (head >> 24, head & 1 != 0);
    let index_width = if wide_index { 2 } else { 1 };
    let mut association = None;
    for _ in 0..fields.number(4)? {
        let id = fields.number(if version < 1 { 2 } else { 4 })?;
        let count = fields.number(1)? as usize;
        let indexes = fields.take(count * index_width)?;
        if id == u64::from(primary) {
            association = Some(indexes);
        }
    }
    let mut item = Item::default();
    for index in association
        .ok_or(Declined::Container)?
        .chunks_exact(index_width)
    {
        let index = match *index {
            [high, low] => usize::from(u16::from_be_bytes([high, low]) & 0x7fff),
            [low] => usize::from(low & 0x7f),
            _ => return Err(Declined::Container),
        };
        let &(kind, property) = index
            .checked_sub(1)
            .and_then(|index| held.get(index))
            .ok_or(Declined::Container)?;
        match kind {
            b"ispe" => {
                let mut size = Fields(property);
                size.number(4)?;
                item.width = size.number(4)? as u32;
                item.height = size.number(4)? as u32;
            }
            b"av1C" => {
                item.configuration = property.to_vec();
                // Marker and version; profile 0; neither high depth, monochrome, nor other than
                // 4:2:0 subsampling.
                let &[0x81, level, depth, ..] = property else {
                    return Err(Declined::Format);
                };
                if level >> 5 != 0 || depth & 0b0111_1100 != 0b0000_1100 {
                    return Err(Declined::Format);
                }
            }
            b"colr" => {
                let mut colour = Fields(property);
                match colour.take(4)? {
                    b"nclx" if item.colour.is_none() => {
                        colour.number(4)?;
                        let matrix = colour.number(2)? as u16;
                        item.colour = Some((matrix, colour.number(1)? & 0x80 != 0));
                    }
                    // A profile libvips has read too, and applies as it would to its own pixels.
                    b"prof" | b"rICC" => {}
                    _ => return Err(Declined::Properties),
                }
            }
            b"pixi" => {}
            _ => return Err(Declined::Properties),
        }
    }
    if item.configuration.is_empty() || item.width == 0 || item.height == 0 {
        return Err(Declined::Format);
    }
    Ok(item)
}

/// Where the primary item's bytes are: one extent, at an offset into the file.
fn read_location(body: &[u8], primary: u32) -> Result<(usize, usize), Declined> {
    let mut fields = Fields(body);
    let version = fields.number(4)? >> 24;
    let sizes = fields.number(2)?;
    let (offset_size, length_size, base_size, index_size) = (
        (sizes >> 12) as usize & 15,
        (sizes >> 8) as usize & 15,
        (sizes >> 4) as usize & 15,
        sizes as usize & 15,
    );
    // Offsets and lengths of no bytes tell nothing, and a loop over them advances through nothing.
    if offset_size == 0 || length_size == 0 {
        return Err(Declined::Container);
    }
    let count = fields.number(if version < 2 { 2 } else { 4 })?;
    for _ in 0..count {
        let id = fields.number(if version < 2 { 2 } else { 4 })?;
        let method = if version >= 1 { fields.number(2)? } else { 0 };
        fields.number(2)?;
        let base = fields.number(base_size)?;
        let extents = fields.number(2)?;
        let mut found = None;
        for _ in 0..extents {
            if version >= 1 {
                fields.number(index_size)?;
            }
            let offset = fields.number(offset_size)?;
            let length = fields.number(length_size)?;
            found = Some((offset, length));
        }
        if id == u64::from(primary) {
            let (offset, length) = found.ok_or(Declined::Container)?;
            if extents != 1 || method & 15 != 0 {
                return Err(Declined::Container);
            }
            let offset = base.checked_add(offset).ok_or(Declined::Container)?;
            return Ok((
                usize::try_from(offset).map_err(|_| Declined::Container)?,
                usize::try_from(length).map_err(|_| Declined::Container)?,
            ));
        }
    }
    Err(Declined::Container)
}

/// A reader of an AV1 header's fields, most significant bit first.
struct Bits<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn take(&mut self, count: u32) -> Result<u64, Declined> {
        let mut value = 0;
        for _ in 0..count {
            let byte = self.bytes.get(self.at / 8).ok_or(Declined::Sequence)?;
            value = (value << 1) | u64::from((byte >> (7 - self.at % 8)) & 1);
            self.at += 1;
        }
        Ok(value)
    }

    fn flag(&mut self) -> Result<bool, Declined> {
        Ok(self.take(1)? == 1)
    }

    /// The specification's `uvlc`.
    fn uvlc(&mut self) -> Result<(), Declined> {
        let mut zeros = 0;
        while !self.flag()? {
            zeros += 1;
            if zeros >= 32 {
                return Ok(());
            }
        }
        self.take(zeros)?;
        Ok(())
    }
}

/// Finds the item's sequence header, and returns its matrix and range. It declines film grain,
/// which aom applies and a decoder need not, and anything but 8-bit 4:2:0 in colour. The fields are
/// `sequence_header_obu`'s, in order.
fn read_sequence_header(mut data: &[u8]) -> Result<(u16, bool), Declined> {
    let header = loop {
        let &first = data.first().ok_or(Declined::Sequence)?;
        let kind = (first >> 3) & 15;
        let extension = usize::from(first & 4 != 0);
        if first & 2 == 0 {
            return Err(Declined::Sequence);
        }
        let mut at = 1 + extension;
        let mut size = 0usize;
        for shift in 0..8 {
            let &byte = data.get(at).ok_or(Declined::Sequence)?;
            at += 1;
            size |= usize::from(byte & 0x7f) << (shift * 7);
            if byte & 0x80 == 0 {
                break;
            }
        }
        let body = data.get(at..at + size).ok_or(Declined::Sequence)?;
        if kind == 1 {
            break body;
        }
        data = &data[at + size..];
    };
    let mut bits = Bits {
        bytes: header,
        at: 0,
    };
    let profile = bits.take(3)?;
    if profile != 0 {
        return Err(Declined::Format);
    }
    bits.take(1)?;
    let reduced = bits.flag()?;
    if reduced {
        bits.take(5)?;
    } else {
        let mut buffer_delay_length = 0;
        let mut decoder_model = false;
        if bits.flag()? {
            bits.take(64)?;
            if bits.flag()? {
                bits.uvlc()?;
            }
            decoder_model = bits.flag()?;
            if decoder_model {
                buffer_delay_length = bits.take(5)? as u32 + 1;
                bits.take(32 + 5 + 5)?;
            }
        }
        let display_delay = bits.flag()?;
        for _ in 0..=bits.take(5)? {
            bits.take(12)?;
            if bits.take(5)? > 7 {
                bits.take(1)?;
            }
            if decoder_model && bits.flag()? {
                bits.take(buffer_delay_length * 2 + 1)?;
            }
            if display_delay && bits.flag()? {
                bits.take(4)?;
            }
        }
    }
    let width_bits = bits.take(4)? as u32 + 1;
    let height_bits = bits.take(4)? as u32 + 1;
    bits.take(width_bits + height_bits)?;
    if !reduced && bits.flag()? {
        bits.take(7)?;
    }
    bits.take(3)?;
    if !reduced {
        bits.take(4)?;
        let order_hint = bits.flag()?;
        if order_hint {
            bits.take(2)?;
        }
        let force_screen_content = if bits.flag()? { 2 } else { bits.take(1)? };
        if force_screen_content > 0 && !bits.flag()? {
            bits.take(1)?;
        }
        if order_hint {
            bits.take(3)?;
        }
    }
    bits.take(3)?;
    // `color_config`, for profile 0.
    if bits.flag()? || bits.flag()? {
        return Err(Declined::Format);
    }
    let described = bits.flag()?;
    let (primaries, transfer, matrix) = if described {
        (bits.take(8)?, bits.take(8)?, bits.take(8)?)
    } else {
        (2, 2, 2)
    };
    if (primaries, transfer, matrix) == (1, 13, 0) {
        return Err(Declined::Format);
    }
    let full_range = bits.flag()?;
    bits.take(2 + 1)?;
    if bits.flag()? {
        return Err(Declined::Sequence);
    }
    Ok((matrix as u16, full_range))
}

type Status = i32;
type CfRef = *const c_void;

const CODEC_AV1: u32 = u32::from_be_bytes(*b"av01");
/// `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`: the planes as decoded. The full-range format
/// would have Core Video scale them, as nothing tells it that they already are.
const PLANES_AS_DECODED: i32 = i32::from_be_bytes(*b"420v");
const LOCK_READ_ONLY: u64 = 1;
const CF_NUMBER_I32: i64 = 3;

#[repr(C)]
#[derive(Clone, Copy)]
struct CmTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

type Output = unsafe extern "C" fn(*mut c_void, *mut c_void, Status, u32, CfRef, CmTime, CmTime);

#[repr(C)]
struct OutputRecord {
    callback: Output,
    context: *mut c_void,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFAllocatorNull: CfRef;
    static kCFBooleanTrue: CfRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFRelease(object: CfRef);
    fn CFDataCreate(allocator: CfRef, bytes: *const u8, length: isize) -> CfRef;
    fn CFNumberCreate(allocator: CfRef, kind: i64, value: *const c_void) -> CfRef;
    fn CFStringCreateWithCString(allocator: CfRef, text: *const i8, encoding: u32) -> CfRef;
    fn CFDictionaryCreate(
        allocator: CfRef,
        keys: *const CfRef,
        values: *const CfRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CfRef;
}

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
    static kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms: CfRef;
    fn CMVideoFormatDescriptionCreate(
        allocator: CfRef,
        codec: u32,
        width: i32,
        height: i32,
        extensions: CfRef,
        out: *mut CfRef,
    ) -> Status;
    fn CMBlockBufferCreateWithMemoryBlock(
        allocator: CfRef,
        memory: *mut c_void,
        length: usize,
        block_allocator: CfRef,
        custom_source: *const c_void,
        offset: usize,
        data_length: usize,
        flags: u32,
        out: *mut CfRef,
    ) -> Status;
    fn CMSampleBufferCreateReady(
        allocator: CfRef,
        data: CfRef,
        format: CfRef,
        samples: isize,
        timings: isize,
        timing: *const c_void,
        sizes: isize,
        size: *const usize,
        out: *mut CfRef,
    ) -> Status;
}

#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    static kCVPixelBufferPixelFormatTypeKey: CfRef;
    fn CVPixelBufferRetain(buffer: CfRef) -> CfRef;
    fn CVPixelBufferRelease(buffer: CfRef);
    fn CVPixelBufferLockBaseAddress(buffer: CfRef, flags: u64) -> Status;
    fn CVPixelBufferUnlockBaseAddress(buffer: CfRef, flags: u64) -> Status;
    fn CVPixelBufferGetWidthOfPlane(buffer: CfRef, plane: usize) -> usize;
    fn CVPixelBufferGetHeightOfPlane(buffer: CfRef, plane: usize) -> usize;
    fn CVPixelBufferGetBytesPerRowOfPlane(buffer: CfRef, plane: usize) -> usize;
    fn CVPixelBufferGetBaseAddressOfPlane(buffer: CfRef, plane: usize) -> *const u8;
}

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    static kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: CfRef;
    fn VTIsHardwareDecodeSupported(codec: u32) -> u8;
    fn VTDecompressionSessionCreate(
        allocator: CfRef,
        format: CfRef,
        specification: CfRef,
        attributes: CfRef,
        output: *const OutputRecord,
        out: *mut CfRef,
    ) -> Status;
    fn VTDecompressionSessionDecodeFrame(
        session: CfRef,
        sample: CfRef,
        flags: u32,
        context: *mut c_void,
        info: *mut u32,
    ) -> Status;
    fn VTDecompressionSessionWaitForAsynchronousFrames(session: CfRef) -> Status;
    fn VTDecompressionSessionInvalidate(session: CfRef);
}

/// A Core Foundation object this owns.
struct Owned(CfRef);

impl Owned {
    /// Takes an object a create function gave, or fails on none.
    fn new(object: CfRef) -> Result<Self, Declined> {
        if object.is_null() {
            Err(Declined::Decoder)
        } else {
            Ok(Self(object))
        }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: an object this holds the one reference it took.
        unsafe { CFRelease(self.0) }
    }
}

/// A decompression session, invalidated before it is released, as Apple asks, on every way out.
struct Session(Owned);

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: the session is live until `Owned` releases it, which comes after this.
        unsafe { VTDecompressionSessionInvalidate(self.0.0) }
    }
}

/// A one-entry Core Foundation dictionary.
fn dictionary(key: CfRef, value: CfRef) -> Result<Owned, Declined> {
    // SAFETY: one key and one value, both live objects, retained by the dictionary.
    Owned::new(unsafe {
        CFDictionaryCreate(
            ptr::null(),
            &raw const key,
            &raw const value,
            1,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        )
    })
}

/// What the decoder hands back.
struct Decoded {
    status: Status,
    /// How many frames came back. A still is one, and more says this is not the file it seemed.
    frames: u32,
    /// The first of them.
    buffer: CfRef,
}

unsafe extern "C" fn on_output(
    _: *mut c_void,
    frame: *mut c_void,
    status: Status,
    _: u32,
    buffer: CfRef,
    _: CmTime,
    _: CmTime,
) {
    // SAFETY: `frame` is the `Decoded` given to the decode call, which waits for this.
    let decoded = unsafe { &mut *frame.cast::<Decoded>() };
    decoded.status = status;
    decoded.frames += 1;
    if decoded.buffer.is_null() && !buffer.is_null() {
        // SAFETY: a live pixel buffer, retained until `decode_planes` lets it go.
        decoded.buffer = unsafe { CVPixelBufferRetain(buffer) };
    }
}

/// Decodes the item's bytes on a session of its own, hardware only, and turns the planes to RGB.
fn decode_planes(item: &Item, data: &[u8]) -> Result<HardwareStill, Declined> {
    let width = i32::try_from(item.width).map_err(|_| Declined::Decoder)?;
    let height = i32::try_from(item.height).map_err(|_| Declined::Decoder)?;
    let length = isize::try_from(item.configuration.len()).map_err(|_| Declined::Decoder)?;
    let succeeded = |status: Status| {
        if status == 0 {
            Ok(())
        } else {
            Err(Declined::Decoder)
        }
    };
    // SAFETY: every call below takes live objects this function made, each held by an `Owned` for
    // as long as it is used, and out-pointers to locals. `data` outlives the sample, whose block
    // does not own it (the null allocator) and which is released before this returns.
    unsafe {
        let configuration = Owned::new(CFDataCreate(
            ptr::null(),
            item.configuration.as_ptr(),
            length,
        ))?;
        let name = Owned::new(CFStringCreateWithCString(
            ptr::null(),
            c"av1C".as_ptr(),
            0x0800_0100,
        ))?;
        let atoms = dictionary(name.0, configuration.0)?;
        let extensions = dictionary(
            kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms,
            atoms.0,
        )?;
        let mut format = ptr::null();
        succeeded(CMVideoFormatDescriptionCreate(
            ptr::null(),
            CODEC_AV1,
            width,
            height,
            extensions.0,
            &raw mut format,
        ))?;
        let format = Owned::new(format)?;
        let specification = dictionary(
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder,
            kCFBooleanTrue,
        )?;
        let planes_as_decoded = PLANES_AS_DECODED;
        let pixel_format = Owned::new(CFNumberCreate(
            ptr::null(),
            CF_NUMBER_I32,
            (&raw const planes_as_decoded).cast(),
        ))?;
        let attributes = dictionary(kCVPixelBufferPixelFormatTypeKey, pixel_format.0)?;
        let record = OutputRecord {
            callback: on_output,
            context: ptr::null_mut(),
        };
        let mut session = ptr::null();
        succeeded(VTDecompressionSessionCreate(
            ptr::null(),
            format.0,
            specification.0,
            attributes.0,
            &raw const record,
            &raw mut session,
        ))?;
        let session = Session(Owned::new(session)?);
        let mut block = ptr::null();
        succeeded(CMBlockBufferCreateWithMemoryBlock(
            ptr::null(),
            data.as_ptr().cast_mut().cast(),
            data.len(),
            kCFAllocatorNull,
            ptr::null(),
            0,
            data.len(),
            0,
            &raw mut block,
        ))?;
        let block = Owned::new(block)?;
        let size = data.len();
        let mut sample = ptr::null();
        succeeded(CMSampleBufferCreateReady(
            ptr::null(),
            block.0,
            format.0,
            1,
            0,
            ptr::null(),
            1,
            &raw const size,
            &raw mut sample,
        ))?;
        let sample = Owned::new(sample)?;
        let mut decoded = Decoded {
            status: 0,
            frames: 0,
            buffer: ptr::null(),
        };
        let mut info = 0;
        let status = VTDecompressionSessionDecodeFrame(
            session.0.0,
            sample.0,
            0,
            (&raw mut decoded).cast(),
            &raw mut info,
        );
        VTDecompressionSessionWaitForAsynchronousFrames(session.0.0);
        drop(session);
        let buffer = decoded.buffer;
        let rgb = if status == 0 && decoded.status == 0 && decoded.frames == 1 && !buffer.is_null()
        {
            rgb_of(buffer, item)
        } else {
            Err(Declined::Decoder)
        };
        if !buffer.is_null() {
            CVPixelBufferRelease(buffer);
        }
        Ok(HardwareStill {
            width: item.width,
            height: item.height,
            rgb: rgb?,
        })
    }
}

/// The pixel buffer's planes as RGB, once its size is the one the file states.
///
/// # Safety
/// `buffer` must be a live bi-planar 4:2:0 pixel buffer.
unsafe fn rgb_of(buffer: CfRef, item: &Item) -> Result<Vec<u8>, Declined> {
    let (width, height) = (item.width as usize, item.height as usize);
    // SAFETY: a live buffer, per the caller; the planes stay valid while it is locked, and the
    // lengths below are the planes' own.
    unsafe {
        if CVPixelBufferGetWidthOfPlane(buffer, 0) != width
            || CVPixelBufferGetHeightOfPlane(buffer, 0) != height
            || CVPixelBufferGetWidthOfPlane(buffer, 1) != width.div_ceil(2)
            || CVPixelBufferGetHeightOfPlane(buffer, 1) != height.div_ceil(2)
            || CVPixelBufferLockBaseAddress(buffer, LOCK_READ_ONLY) != 0
        {
            return Err(Declined::Decoder);
        }
        let luma_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
        let chroma_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
        let luma = std::slice::from_raw_parts(
            CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
            luma_stride * height,
        );
        let chroma = std::slice::from_raw_parts(
            CVPixelBufferGetBaseAddressOfPlane(buffer, 1),
            chroma_stride * height.div_ceil(2),
        );
        let rgb = planes_to_rgb(luma, luma_stride, chroma, chroma_stride, width, height);
        CVPixelBufferUnlockBaseAddress(buffer, LOCK_READ_ONLY);
        Ok(rgb)
    }
}

/// libheif's `Op_YCbCr420_to_RGB24` at 8 bits and full range: each pixel takes the chroma of the
/// 2×2 block it is in, unfiltered, through fixed-point coefficients. The offsets are worked out
/// once a pair of rows, and each row's channels apart, which the compiler can vectorize: this is
/// the largest cost of the route outside libvips.
fn planes_to_rgb(
    luma: &[u8],
    luma_stride: usize,
    chroma: &[u8],
    chroma_stride: usize,
    width: usize,
    height: usize,
) -> Vec<u8> {
    let [red_cr, green_cb, green_cr, blue_cb] = COEFFICIENTS;
    let mut rgb = vec![0u8; width * height * 3];
    // Each pixel's offsets from its luma, channel by channel.
    let mut offsets = [vec![0i16; width], vec![0i16; width], vec![0i16; width]];
    let mut channels = [vec![0u8; width], vec![0u8; width], vec![0u8; width]];
    for (row, out) in rgb.chunks_exact_mut(width * 3).enumerate() {
        if row % 2 == 0 {
            let chroma = &chroma[(row / 2) * chroma_stride..][..width.div_ceil(2) * 2];
            let [red, green, blue] = &mut offsets;
            for (column, pair) in chroma.as_chunks::<2>().0.iter().enumerate() {
                let cb = i32::from(pair[0]) - 128;
                let cr = i32::from(pair[1]) - 128;
                let (r, g, b) = (
                    ((red_cr * cr + 128) >> 8) as i16,
                    ((green_cb * cb + green_cr * cr + 128) >> 8) as i16,
                    ((blue_cb * cb + 128) >> 8) as i16,
                );
                for at in [column * 2, column * 2 + 1] {
                    if at < width {
                        (red[at], green[at], blue[at]) = (r, g, b);
                    }
                }
            }
        }
        let luma = &luma[row * luma_stride..][..width];
        for (channel, offsets) in channels.iter_mut().zip(&offsets) {
            for ((value, &y), &offset) in channel.iter_mut().zip(luma).zip(offsets) {
                *value = (i16::from(y) + offset).clamp(0, 255) as u8;
            }
        }
        let [red, green, blue] = &channels;
        for (pixel, ((&r, &g), &b)) in out
            .as_chunks_mut::<3>()
            .0
            .iter_mut()
            .zip(red.iter().zip(green).zip(blue))
        {
            *pixel = [r, g, b];
        }
    }
    rgb
}

#[cfg(test)]
mod tests {
    use super::*;

    /// libheif's conversion written pixel by pixel, as `Op_YCbCr420_to_RGB24` does it.
    fn by_the_pixel(luma: &[u8], chroma: &[u8], width: usize, height: usize) -> Vec<u8> {
        let [red_cr, green_cb, green_cr, blue_cb] = COEFFICIENTS;
        let stride = width.div_ceil(2) * 2;
        let mut rgb = Vec::with_capacity(width * height * 3);
        for row in 0..height {
            for column in 0..width {
                let y = i32::from(luma[row * width + column]);
                let at = (row / 2) * stride + (column / 2) * 2;
                let (cb, cr) = (i32::from(chroma[at]) - 128, i32::from(chroma[at + 1]) - 128);
                rgb.push((y + ((red_cr * cr + 128) >> 8)).clamp(0, 255) as u8);
                rgb.push((y + ((green_cb * cb + green_cr * cr + 128) >> 8)).clamp(0, 255) as u8);
                rgb.push((y + ((blue_cb * cb + 128) >> 8)).clamp(0, 255) as u8);
            }
        }
        rgb
    }

    #[test]
    fn the_conversion_matches_libheifs_on_every_value_and_at_odd_sizes() {
        for (width, height) in [(64, 64), (65, 33), (1, 1), (7, 2)] {
            let bytes = |seed: usize, count: usize| -> Vec<u8> {
                (0..count)
                    .map(|index| (index.wrapping_mul(seed).wrapping_mul(2_654_435_761) >> 13) as u8)
                    .collect()
            };
            let luma = bytes(3, width * height);
            let chroma = bytes(5, width.div_ceil(2) * height.div_ceil(2) * 2);
            assert_eq!(
                planes_to_rgb(&luma, width, &chroma, width.div_ceil(2) * 2, width, height),
                by_the_pixel(&luma, &chroma, width, height)
            );
        }
    }

    /// A box: its 32-bit size, its type and its body.
    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32 + 8).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn a_location_of_no_bytes_is_declined_at_once() {
        // Version 0, no field widths at all, and as many items and extents as the format can say.
        let mut location = vec![0, 0, 0, 0, 0, 0, 0xff, 0xff];
        for _ in 0..0xffff {
            location.extend_from_slice(&[0, 2, 0, 0, 0xff, 0xff]);
        }
        let started = std::time::Instant::now();
        assert_eq!(read_location(&location, 1), Err(Declined::Container));
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn only_the_top_boxes_of_a_file_are_read() {
        let ftyp = boxed(b"ftyp", b"avif\0\0\0\0mif1");
        let meta = boxed(b"meta", &[0; 32]);
        let mut file = [ftyp.clone(), meta].concat();
        let headers = file.len() as u64;
        file.extend_from_slice(&boxed(b"mdat", &[7; 1 << 16]));
        let most_read = std::cell::Cell::new(0u64);
        let read = |offset: u64, bytes: &mut [u8]| {
            most_read.set(
                most_read
                    .get()
                    .max(offset.min(headers) + bytes.len() as u64),
            );
            bytes.copy_from_slice(&file[offset as usize..offset as usize + bytes.len()]);
            Ok(())
        };
        let (read_ftyp, read_meta) = read_top_boxes(file.len() as u64, read).unwrap();
        assert_eq!(read_ftyp, ftyp[8..]);
        assert_eq!(read_meta.len(), 32);
        assert!(most_read.get() <= headers + 16, "read {}", most_read.get());

        // Anything else than an `ftyp` first is not read further.
        let other = boxed(b"mdat", &[0; 64]);
        let read = |offset: u64, bytes: &mut [u8]| {
            bytes.copy_from_slice(&other[offset as usize..offset as usize + bytes.len()]);
            Ok(())
        };
        assert_eq!(
            read_top_boxes(other.len() as u64, read),
            Err(Declined::NotAvif)
        );
    }

    #[test]
    fn a_decode_that_never_answers_gives_up_at_its_limit() {
        let started = std::time::Instant::now();
        let answer = within(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_secs(5));
            1
        });
        assert_eq!(answer, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(within(Duration::from_secs(5), || 2), Some(2));
    }
}
