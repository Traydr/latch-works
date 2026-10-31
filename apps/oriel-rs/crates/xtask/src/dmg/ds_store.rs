//! The `.DS_Store` that lays out the image's Finder window, written as appdmg's `ds-store`
//! writes it, but whole rather than patched into a template file Finder once saved.
//!
//! The file is a buddy-allocated store (`Bud1`): a 32-byte header, then blocks whose sizes are
//! powers of two. Block 0 lists every block's offset, the table of contents (`DSDB`, the one
//! B-tree) and the free blocks; block 1 is the B-tree's master record; block 2 is its only node,
//! a leaf holding the records in Finder's order. A layout of a few icons fits one 4 KiB leaf by
//! far, and the writer says so if one ever does not.

use anyhow::{Result, bail, ensure};

use super::bplist::{self, Value};

/// The leaf's size, and the B-tree's page size, as Finder writes them.
const PAGE_SIZE: usize = 0x1000;

/// One property of one item in the window's folder, `.` being the folder itself.
#[derive(Clone, Debug)]
pub struct Record {
    pub name: String,
    pub code: [u8; 4],
    pub value: RecordValue,
}

#[derive(Clone, Debug)]
pub enum RecordValue {
    Long(u32),
    Blob(Vec<u8>),
}

/// The window's settings: where and how big it opens, and its icon view.
pub struct Window {
    pub x: u32,
    pub y: u32,
    /// The size of the folder's area, without the title bar.
    pub width: u32,
    pub height: u32,
    pub icon_size: u32,
    /// The background picture's alias (`alias::Target::encode`).
    pub background_alias: Vec<u8>,
}

impl Record {
    /// Where an item's icon sits: the centre of the icon, from the window's top left.
    pub fn icon_position(name: &str, x: u32, y: u32) -> Self {
        let mut blob = Vec::with_capacity(16);
        blob.extend_from_slice(&x.to_be_bytes());
        blob.extend_from_slice(&y.to_be_bytes());
        // The rest of the record as appdmg writes it.
        blob.extend_from_slice(&[0xff, 0xff, 0xff, 0x00, 0, 0, 0, 0]);
        Record {
            name: name.to_owned(),
            code: *b"Iloc",
            value: RecordValue::Blob(blob),
        }
    }

    /// The folder's own records: the window (`bwsp`), its icon view (`icvp`) and the version of
    /// those settings (`vSrn`).
    pub fn window(window: &Window) -> Vec<Self> {
        // appdmg adds 22 to the height for the title bar of the macOS it was written for.
        let bounds = format!(
            "{{{{{}, {}}}, {{{}, {}}}}}",
            window.x,
            window.y,
            window.width,
            window.height + 22
        );
        let browser = Value::dict([
            ("ContainerShowSidebar", Value::Bool(true)),
            ("ShowPathbar", Value::Bool(false)),
            ("ShowSidebar", Value::Bool(true)),
            ("ShowStatusBar", Value::Bool(false)),
            ("ShowTabView", Value::Bool(false)),
            ("ShowToolbar", Value::Bool(false)),
            ("SidebarWidth", Value::Integer(0)),
            ("WindowBounds", Value::string(bounds)),
        ]);
        let icon_view = Value::dict([
            // 2: a picture, the alias's.
            ("backgroundType", Value::Integer(2)),
            ("backgroundColorRed", Value::Real(1.0)),
            ("backgroundColorGreen", Value::Real(1.0)),
            ("backgroundColorBlue", Value::Real(1.0)),
            ("showIconPreview", Value::Bool(true)),
            ("showItemInfo", Value::Bool(false)),
            ("textSize", Value::Real(12.0)),
            ("iconSize", Value::Real(f64::from(window.icon_size))),
            ("viewOptionsVersion", Value::Integer(1)),
            ("gridSpacing", Value::Real(100.0)),
            ("gridOffsetX", Value::Real(0.0)),
            ("gridOffsetY", Value::Real(0.0)),
            ("labelOnBottom", Value::Bool(true)),
            ("arrangeBy", Value::string("none")),
            (
                "backgroundImageAlias",
                Value::Data(window.background_alias.clone()),
            ),
        ]);
        vec![
            Record {
                name: ".".into(),
                code: *b"bwsp",
                value: RecordValue::Blob(bplist::encode(&browser)),
            },
            Record {
                name: ".".into(),
                code: *b"icvp",
                value: RecordValue::Blob(bplist::encode(&icon_view)),
            },
            Record {
                name: ".".into(),
                code: *b"vSrn",
                value: RecordValue::Long(1),
            },
        ]
    }

    fn encode(&self, out: &mut Vec<u8>) {
        let units: Vec<u16> = self.name.encode_utf16().collect();
        out.extend_from_slice(&(units.len() as u32).to_be_bytes());
        for unit in &units {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        out.extend_from_slice(&self.code);
        match &self.value {
            RecordValue::Long(value) => {
                out.extend_from_slice(b"long");
                out.extend_from_slice(&value.to_be_bytes());
            }
            RecordValue::Blob(bytes) => {
                out.extend_from_slice(b"blob");
                out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                out.extend_from_slice(bytes);
            }
        }
    }
}

/// Finder's order: by name as HFS+ compares names, ignoring case, then by code.
fn finder_order(a: &Record, b: &Record) -> std::cmp::Ordering {
    let fold = |name: &str| -> Vec<u16> {
        name.encode_utf16()
            .map(|unit| match unit {
                0x41..=0x5a => unit + 0x20,
                _ => unit,
            })
            .collect()
    };
    fold(&a.name)
        .cmp(&fold(&b.name))
        .then_with(|| a.code.cmp(&b.code))
}

/// The `.DS_Store` file holding `records`.
pub fn encode(mut records: Vec<Record>) -> Result<Vec<u8>> {
    // Case folding only covers ASCII; the image's names are all ASCII.
    ensure!(
        records.iter().all(|record| record.name.is_ascii()),
        "a .DS_Store name outside ASCII needs HFS+'s full case folding"
    );
    records.sort_by(finder_order);

    let mut leaf = Vec::with_capacity(PAGE_SIZE);
    // No child pointer: a leaf. Then the record count and the records.
    leaf.extend_from_slice(&0u32.to_be_bytes());
    leaf.extend_from_slice(&(records.len() as u32).to_be_bytes());
    for record in &records {
        record.encode(&mut leaf);
    }
    if leaf.len() > PAGE_SIZE {
        bail!(
            "the window's records take {} bytes, more than one {PAGE_SIZE}-byte leaf",
            leaf.len()
        );
    }

    let mut allocator = Buddy::new();
    // The info block's size: the offsets (padded to 256), the table of contents and up to two
    // free blocks of each size fit 2 KiB.
    let info = allocator.allocate(11);
    let master = allocator.allocate(5);
    let node = allocator.allocate(12);
    let blocks = [(info, 11), (master, 5), (node, 12)];

    let mut info_block = Vec::with_capacity(2048);
    info_block.extend_from_slice(&(blocks.len() as u32).to_be_bytes());
    info_block.extend_from_slice(&0u32.to_be_bytes());
    for (offset, width) in blocks {
        info_block.extend_from_slice(&(offset | width).to_be_bytes());
    }
    info_block.resize(8 + 256 * 4, 0);
    // The table of contents: `DSDB` is block 1.
    info_block.extend_from_slice(&1u32.to_be_bytes());
    info_block.push(4);
    info_block.extend_from_slice(b"DSDB");
    info_block.extend_from_slice(&1u32.to_be_bytes());
    for free in &allocator.free {
        info_block.extend_from_slice(&(free.len() as u32).to_be_bytes());
        for offset in free {
            info_block.extend_from_slice(&offset.to_be_bytes());
        }
    }
    ensure!(
        info_block.len() <= 1 << 11,
        "the store's info block outgrew 2 KiB"
    );

    let mut master_block = Vec::with_capacity(20);
    for value in [2, 0, records.len() as u32, 1, PAGE_SIZE as u32] {
        // The root node's block, the levels under it, the records, the nodes, the page size.
        master_block.extend_from_slice(&value.to_be_bytes());
    }

    // Every offset counts from the fifth byte, after the leading 1.
    let end = (node + PAGE_SIZE as u32) as usize;
    let mut file = vec![0u8; 4 + end];
    file[..4].copy_from_slice(&1u32.to_be_bytes());
    let mut header = Vec::with_capacity(32);
    header.extend_from_slice(b"Bud1");
    header.extend_from_slice(&info.to_be_bytes());
    header.extend_from_slice(&(1u32 << 11).to_be_bytes());
    header.extend_from_slice(&info.to_be_bytes());
    // Sixteen bytes no reader uses; Finder's own files start them with 0x100C.
    header.extend_from_slice(&0x100cu32.to_be_bytes());
    header.resize(32, 0);
    for (offset, bytes) in [
        (0, &header),
        (info, &info_block),
        (master, &master_block),
        (node, &leaf),
    ] {
        let at = 4 + offset as usize;
        file[at..at + bytes.len()].copy_from_slice(bytes);
    }
    Ok(file)
}

/// The store's allocator: free blocks of each power of two from 2^0 to 2^31 bytes, split in
/// halves ("buddies") on demand. A new store has the 32-byte header taken from offset 0.
struct Buddy {
    free: Vec<Vec<u32>>,
}

impl Buddy {
    fn new() -> Self {
        let mut free = vec![Vec::new(); 32];
        free[31].push(0);
        let mut allocator = Buddy { free };
        let header = allocator.allocate(5);
        debug_assert_eq!(header, 0);
        allocator
    }

    /// A free block of 2^`width` bytes, splitting a larger one if none is free.
    fn allocate(&mut self, width: usize) -> u32 {
        if let Some(offset) = self.free[width].first().copied() {
            self.free[width].remove(0);
            return offset;
        }
        let offset = self.allocate(width + 1);
        self.free[width].push(offset ^ (1 << width));
        offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u32(file: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(file[at..at + 4].try_into().unwrap())
    }

    /// The store's blocks are where its header and info block say, with the records in
    /// Finder's order in the leaf the B-tree's master record names.
    #[test]
    fn blocks_and_records_are_where_finder_reads_them() {
        let mut records = vec![
            Record::icon_position("Oriel RS.app", 180, 180),
            Record::icon_position("Applications", 480, 180),
        ];
        records.extend(Record::window(&Window {
            x: 100,
            y: 100,
            width: 660,
            height: 400,
            icon_size: 128,
            background_alias: vec![0; 300],
        }));
        let file = encode(records).unwrap();

        assert_eq!(&file[4..8], b"Bud1");
        let info = read_u32(&file, 8) as usize;
        assert_eq!(read_u32(&file, 12), 2048);
        assert_eq!(read_u32(&file, 16) as usize, info);
        let info = 4 + info;
        assert_eq!(read_u32(&file, info), 3);
        let addresses: Vec<u32> = (0..3).map(|i| read_u32(&file, info + 8 + i * 4)).collect();
        assert_eq!(addresses[0] as usize & !0x1f, info - 4);
        let toc = info + 8 + 256 * 4;
        assert_eq!(read_u32(&file, toc), 1);
        assert_eq!(&file[toc + 4..toc + 9], b"\x04DSDB");
        assert_eq!(read_u32(&file, toc + 9), 1);

        let master = 4 + (addresses[1] & !0x1f) as usize;
        assert_eq!(read_u32(&file, master), 2);
        assert_eq!(read_u32(&file, master + 8), 5);
        let leaf = 4 + (addresses[2] & !0x1f) as usize;
        assert_eq!(addresses[2] & 0x1f, 12);
        assert!(file.len() >= leaf + PAGE_SIZE);
        assert_eq!(read_u32(&file, leaf), 0);
        assert_eq!(read_u32(&file, leaf + 4), 5);

        let mut at = leaf + 8;
        let mut order = Vec::new();
        for _ in 0..5 {
            let length = read_u32(&file, at) as usize;
            let name: Vec<u16> = (0..length)
                .map(|i| u16::from_be_bytes([file[at + 4 + i * 2], file[at + 5 + i * 2]]))
                .collect();
            at += 4 + length * 2;
            let code = String::from_utf8(file[at..at + 4].to_vec()).unwrap();
            let kind = &file[at + 4..at + 8];
            at += 8 + if kind == b"long" {
                4
            } else {
                4 + read_u32(&file, at + 8) as usize
            };
            order.push(format!("{} {code}", String::from_utf16(&name).unwrap()));
        }
        assert_eq!(
            order,
            [
                ". bwsp",
                ". icvp",
                ". vSrn",
                "Applications Iloc",
                "Oriel RS.app Iloc"
            ]
        );
    }
}
