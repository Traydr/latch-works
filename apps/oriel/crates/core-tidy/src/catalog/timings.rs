//! How long this machine's SVT-AV1 encodes took, which Shrink's estimate of encode times learns
//! from. The catalog lives in this machine's data folder, so these are this machine's speeds.

use rusqlite::{Connection, params};

use super::now_ms;

/// Timings kept; older ones are dropped as new ones come in.
const KEPT: i64 = 500;

/// One timed SVT-AV1 encode.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EncodeTiming {
    pub pixels: f64,
    pub media_ms: f64,
    pub wall_ms: f64,
}

pub(crate) fn record_encode_timing(
    connection: &Connection,
    timing: EncodeTiming,
) -> anyhow::Result<()> {
    connection.execute(
        "INSERT INTO encode_timings (encoder, pixels, media_ms, wall_ms, at)
      VALUES ('svt-av1', ?1, ?2, ?3, ?4)",
        params![timing.pixels, timing.media_ms, timing.wall_ms, now_ms()],
    )?;
    connection.execute(
        "DELETE FROM encode_timings WHERE id <= (SELECT MAX(id) FROM encode_timings) - ?1",
        [KEPT],
    )?;
    Ok(())
}

/// The kept timings of encodes of at least `min_media_ms` of media, newest first.
pub(crate) fn encode_timings(
    connection: &Connection,
    min_media_ms: f64,
) -> anyhow::Result<Vec<EncodeTiming>> {
    let mut statement = connection.prepare_cached(
        "SELECT pixels, media_ms, wall_ms FROM encode_timings
      WHERE encoder = 'svt-av1' AND media_ms >= ?1 AND wall_ms > 0
      ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![min_media_ms, KEPT], |row| {
        Ok(EncodeTiming {
            pixels: row.get(0)?,
            media_ms: row.get(1)?,
            wall_ms: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
