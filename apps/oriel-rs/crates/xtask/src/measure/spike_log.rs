//! Reading a spike's log as it grows: one JSON object per line, appended while the app runs.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Hands out the lines a spike has finished writing since the last call.
pub struct LogReader {
    path: PathBuf,
    offset: u64,
}

impl LogReader {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            offset: 0,
        }
    }

    /// The events written since the last call. A line still being written waits for the next
    /// call; a line that is not JSON is skipped.
    pub fn new_events(&mut self) -> Vec<Value> {
        let Ok(mut file) = File::open(&self.path) else {
            return Vec::new();
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut text = String::new();
        if file.read_to_string(&mut text).is_err() {
            return Vec::new();
        }
        let Some(end) = text.rfind('\n') else {
            return Vec::new();
        };
        self.offset += end as u64 + 1;
        text[..end]
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
}

/// The first event called `name` whose fields match `fields`.
pub fn find<'a>(events: &'a [Value], name: &str, fields: &[(&str, &str)]) -> Option<&'a Value> {
    events.iter().find(|event| {
        event["event"] == name
            && fields
                .iter()
                .all(|(key, value)| event[*key].as_str() == Some(*value))
    })
}

/// A number from the first event called `name`, or NaN, which the summary leaves out.
pub fn number(events: &[Value], name: &str, field: &str) -> f64 {
    find(events, name, &[])
        .and_then(|event| event[field].as_f64())
        .unwrap_or(f64::NAN)
}
