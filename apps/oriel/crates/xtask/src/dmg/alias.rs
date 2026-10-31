//! The alias record that points Finder at the window's background picture, as appdmg's
//! `macos-alias` writes it: a version 2 alias with the volume's and the file's names, their
//! catalog IDs and creation dates, and the file's path from the volume's root.
//!
//! Finder finds the picture by the volume's name and that path when the IDs no longer match, so
//! the alias written on the build's scratch mount still works where the owner mounts the image.

use std::os::darwin::fs::MetadataExt as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use anyhow::{Context as _, Result, bail};

/// Seconds from 1904-01-01, the classic Mac OS epoch, to 1970-01-01.
const MAC_EPOCH_OFFSET: i64 = 2_082_844_800;

/// What the alias says about its target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// The volume's name, which Finder shows; at most 27 bytes.
    pub volume_name: String,
    /// Where macOS mounts the volume when the owner opens the image, `/Volumes/<name>`.
    pub volume_path: String,
    /// The volume's creation date, in seconds since 1904.
    pub volume_created: u32,
    /// The folder holding the file: its name and catalog ID.
    pub parent_name: String,
    pub parent_id: u32,
    /// The file: its name (at most 63 bytes), catalog ID and creation date.
    pub file_name: String,
    pub file_id: u32,
    pub file_created: u32,
    /// The file's path from the volume's root, starting with `/`.
    pub path_in_volume: String,
}

impl Target {
    /// Reads the IDs and dates of `file`, a file in the folder `parent` directly under the
    /// volume mounted at `mount`, for a volume Finder will mount as `/Volumes/<volume_name>`.
    pub fn read(mount: &Path, parent: &str, file: &str, volume_name: &str) -> Result<Self> {
        let parent_path = mount.join(parent);
        let file_path = parent_path.join(file);
        let volume = mount.metadata().context("reading the image's volume")?;
        let folder = parent_path
            .metadata()
            .context("reading the background folder")?;
        let picture = file_path.metadata().context("reading the background")?;
        Ok(Target {
            volume_name: volume_name.to_owned(),
            volume_path: format!("/Volumes/{volume_name}"),
            // HFS+ keeps the volume's creation date as its root folder's.
            volume_created: mac_date(volume.st_birthtime())?,
            parent_name: parent.to_owned(),
            parent_id: catalog_id(folder.ino())?,
            file_name: file.to_owned(),
            file_id: catalog_id(picture.ino())?,
            file_created: mac_date(picture.st_birthtime())?,
            path_in_volume: format!("/{parent}/{file}"),
        })
    }

    /// The alias record's bytes.
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.volume_name.len() > 27 {
            bail!(
                "the volume name {} is longer than an alias holds",
                self.volume_name
            );
        }
        if self.file_name.len() > 63 {
            bail!(
                "the file name {} is longer than an alias holds",
                self.file_name
            );
        }
        let mut out = Vec::with_capacity(512);
        // The creator code, then the record's length, filled in at the end, and version 2.
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&2u16.to_be_bytes());
        // A file, not a folder.
        out.extend_from_slice(&0u16.to_be_bytes());
        push_pascal(&mut out, &self.volume_name, 27);
        out.extend_from_slice(&self.volume_created.to_be_bytes());
        out.extend_from_slice(b"H+");
        // The volume kind: "other", any volume but the startup disk.
        out.extend_from_slice(&5u16.to_be_bytes());
        out.extend_from_slice(&self.parent_id.to_be_bytes());
        push_pascal(&mut out, &self.file_name, 63);
        out.extend_from_slice(&self.file_id.to_be_bytes());
        out.extend_from_slice(&self.file_created.to_be_bytes());
        // No file type or creator code.
        out.extend_from_slice(&[0; 8]);
        // No levels between the alias's folder and the target's, either way.
        out.extend_from_slice(&(-1i16).to_be_bytes());
        out.extend_from_slice(&(-1i16).to_be_bytes());
        // The volume's attributes and file system ID, as macos-alias always writes them.
        out.extend_from_slice(&0x0000_0d02u32.to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&[0; 10]);
        debug_assert_eq!(out.len(), 150);

        // The tagged extras: the parent folder's name and ID, the file's and the volume's
        // Unicode names, the file's path in the volume and the volume's mount point.
        push_extra(&mut out, 0, self.parent_name.as_bytes());
        push_extra(&mut out, 1, &self.parent_id.to_be_bytes());
        push_extra(&mut out, 14, &unicode_name(&self.file_name));
        push_extra(&mut out, 15, &unicode_name(&self.volume_name));
        push_extra(&mut out, 18, self.path_in_volume.as_bytes());
        push_extra(&mut out, 19, self.volume_path.as_bytes());
        out.extend_from_slice(&(-1i16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());

        let length = u16::try_from(out.len()).context("the alias is too long")?;
        out[4..6].copy_from_slice(&length.to_be_bytes());
        Ok(out)
    }
}

/// A length byte, then the text, padded with zeros to `room` bytes.
fn push_pascal(out: &mut Vec<u8>, text: &str, room: usize) {
    out.push(text.len() as u8);
    out.extend_from_slice(text.as_bytes());
    out.resize(out.len() + room - text.len(), 0);
}

/// A tag, the length, the data, and a zero byte when the length is odd.
fn push_extra(out: &mut Vec<u8>, tag: i16, data: &[u8]) {
    out.extend_from_slice(&tag.to_be_bytes());
    out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
}

/// A count of UTF-16 units, then the units, big-endian.
fn unicode_name(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = (units.len() as u16).to_be_bytes().to_vec();
    for unit in units {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out
}

fn mac_date(unix_seconds: i64) -> Result<u32> {
    u32::try_from(unix_seconds + MAC_EPOCH_OFFSET).context("a date an alias holds")
}

fn catalog_id(inode: u64) -> Result<u32> {
    u32::try_from(inode).context("an HFS+ catalog ID fits in 32 bits")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The alias in Electron Oriel's 0.1.4 DMG, which appdmg wrote, byte for byte: a port of
    /// `macos-alias` must write the same record for the same picture.
    #[test]
    fn writes_appdmg_alias_for_electron_oriel_picture() {
        let target = Target {
            volume_name: "Oriel".into(),
            volume_path: "/Volumes/Oriel".into(),
            volume_created: 0xe705_336d,
            parent_name: ".background".into(),
            parent_id: 18,
            file_name: "dmg-background.tiff".into(),
            file_id: 19,
            file_created: 0xe705_336d,
            path_in_volume: "/.background/dmg-background.tiff".into(),
        };
        let expected = concat!(
            "00000000012400020000054f7269656c00000000000000000000000000000000000000000000e705",
            "336d482b00050000001213646d672d6261636b67726f756e642e7469666600000000000000000000",
            "0000000000000000000000000000000000000000000000000000000000000000000000000013e705",
            "336d0000000000000000ffffffff00000d020000000000000000000000000000000b2e6261636b67",
            "726f756e64000001000400000012000e002800130064006d0067002d006200610063006b00670072",
            "006f0075006e0064002e0074006900660066000f000c0005004f007200690065006c001200202f2e",
            "6261636b67726f756e642f646d672d6261636b67726f756e642e746966660013000e2f566f6c756d",
            "65732f4f7269656cffff0000",
        );
        let expected: Vec<u8> = expected
            .as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        assert_eq!(target.encode().unwrap(), expected);
    }
}
