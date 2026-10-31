//! The binary property lists the `.DS_Store` carries its window and view settings in
//! (`bplist00`), written as appdmg's `bplist-creator` writes them: only the kinds those settings
//! use, with no shared objects.

/// One value in a property list.
#[derive(Clone, Debug)]
pub enum Value {
    Bool(bool),
    Integer(u64),
    Real(f64),
    String(String),
    Data(Vec<u8>),
    /// Keys in the order given, as Finder writes them.
    Dict(Vec<(String, Value)>),
}

impl Value {
    /// A dictionary from `(key, value)` pairs.
    pub fn dict(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Self {
        Value::Dict(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }

    pub fn string(text: impl Into<String>) -> Self {
        Value::String(text.into())
    }
}

/// The value as a `bplist00` file.
pub fn encode(root: &Value) -> Vec<u8> {
    // Each object is laid out flat, a dictionary's keys and values after it, then referred to
    // by its index in the offset table.
    let mut objects = Vec::new();
    flatten(root, &mut objects);
    let count = objects.len();
    let ref_size = if count <= 0xff { 1 } else { 2 };

    let mut out = b"bplist00".to_vec();
    let mut offsets = Vec::with_capacity(count);
    for object in &objects {
        offsets.push(out.len());
        match object {
            Flat::Bool(value) => out.push(if *value { 0x09 } else { 0x08 }),
            Flat::Integer(value) => push_integer(&mut out, *value),
            Flat::Real(value) => {
                out.push(0x23);
                out.extend_from_slice(&value.to_be_bytes());
            }
            Flat::String(text) if text.is_ascii() => {
                push_marker(&mut out, 0x50, text.len());
                out.extend_from_slice(text.as_bytes());
            }
            Flat::String(text) => {
                let units: Vec<u16> = text.encode_utf16().collect();
                push_marker(&mut out, 0x60, units.len());
                for unit in units {
                    out.extend_from_slice(&unit.to_be_bytes());
                }
            }
            Flat::Data(bytes) => {
                push_marker(&mut out, 0x40, bytes.len());
                out.extend_from_slice(bytes);
            }
            Flat::Dict { keys, values } => {
                push_marker(&mut out, 0xd0, keys.len());
                for reference in keys.iter().chain(values) {
                    push_sized(&mut out, *reference as u64, ref_size);
                }
            }
        }
    }

    let table = out.len();
    let offset_size = bytes_for(table as u64);
    for offset in offsets {
        push_sized(&mut out, offset as u64, offset_size);
    }
    out.extend_from_slice(&[0; 6]);
    out.push(offset_size as u8);
    out.push(ref_size as u8);
    out.extend_from_slice(&(count as u64).to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes());
    out.extend_from_slice(&(table as u64).to_be_bytes());
    out
}

/// An object with its children replaced by their indices.
enum Flat<'a> {
    Bool(bool),
    Integer(u64),
    Real(f64),
    String(&'a str),
    Data(&'a [u8]),
    Dict {
        keys: Vec<usize>,
        values: Vec<usize>,
    },
}

fn flatten<'a>(value: &'a Value, objects: &mut Vec<Flat<'a>>) -> usize {
    let index = objects.len();
    match value {
        Value::Bool(value) => objects.push(Flat::Bool(*value)),
        Value::Integer(value) => objects.push(Flat::Integer(*value)),
        Value::Real(value) => objects.push(Flat::Real(*value)),
        Value::String(text) => objects.push(Flat::String(text)),
        Value::Data(bytes) => objects.push(Flat::Data(bytes)),
        Value::Dict(entries) => {
            objects.push(Flat::Dict {
                keys: Vec::new(),
                values: Vec::new(),
            });
            let keys = entries
                .iter()
                .map(|(key, _)| {
                    objects.push(Flat::String(key));
                    objects.len() - 1
                })
                .collect();
            let values = entries
                .iter()
                .map(|(_, value)| flatten(value, objects))
                .collect();
            objects[index] = Flat::Dict { keys, values };
        }
    }
    index
}

/// A marker with its length in the low nibble, or 0xF and the length as an integer after it.
fn push_marker(out: &mut Vec<u8>, kind: u8, length: usize) {
    if length < 0xf {
        out.push(kind | length as u8);
    } else {
        out.push(kind | 0xf);
        push_integer(out, length as u64);
    }
}

fn push_integer(out: &mut Vec<u8>, value: u64) {
    let size = bytes_for(value);
    out.push(0x10 | size.trailing_zeros() as u8);
    push_sized(out, value, size);
}

/// The fewest bytes, 1, 2, 4 or 8, that hold `value`.
fn bytes_for(value: u64) -> usize {
    match value {
        0..=0xff => 1,
        0x100..=0xffff => 2,
        0x1_0000..=0xffff_ffff => 4,
        _ => 8,
    }
}

fn push_sized(out: &mut Vec<u8>, value: u64, size: usize) {
    out.extend_from_slice(&value.to_be_bytes()[8 - size..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// macOS's own reader takes the list: `plutil` prints back each kind written.
    #[test]
    fn plutil_reads_every_kind() {
        let list = Value::dict([
            ("flag", Value::Bool(true)),
            ("small", Value::Integer(2)),
            ("large", Value::Integer(70_000)),
            ("size", Value::Real(128.0)),
            ("arrange", Value::string("none")),
            ("long", Value::string("{{100, 100}, {660, 422}}")),
            ("wide", Value::string("Oriel R\u{e9}")),
            ("alias", Value::Data(vec![0xab; 300])),
            ("nested", Value::dict([("off", Value::Bool(false))])),
        ]);
        let folder = std::env::temp_dir().join(format!("xtask-bplist-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("list.plist");
        std::fs::write(&file, encode(&list)).unwrap();
        let output = std::process::Command::new("/usr/bin/plutil")
            .args(["-convert", "xml1", "-o", "-"])
            .arg(&file)
            .output()
            .unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        assert!(output.status.success(), "{output:?}");
        let xml = String::from_utf8(output.stdout).unwrap();
        for expected in [
            "<key>flag</key>\n\t<true/>",
            "<key>small</key>\n\t<integer>2</integer>",
            "<key>large</key>\n\t<integer>70000</integer>",
            "<key>size</key>\n\t<real>128</real>",
            "<key>arrange</key>\n\t<string>none</string>",
            "<key>long</key>\n\t<string>{{100, 100}, {660, 422}}</string>",
            "<key>wide</key>\n\t<string>Oriel R\u{e9}</string>",
            "<key>alias</key>\n\t<data>\n\tq6ur",
            "<key>off</key>\n\t\t<false/>",
        ] {
            assert!(xml.contains(expected), "{expected} is not in\n{xml}");
        }
    }
}
