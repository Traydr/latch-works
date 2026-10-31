//! A TCP proxy on this machine whose upload direction is held to a fixed rate, shared by every
//! connection through it, as one slow link would be: for checking that Sync's adaptive upload
//! width settles low when the link, not the width, is the limit.
//!
//! ```sh
//! cargo run --release -p oriel-core-sync --example throttle_proxy -- 9100 9000 2000000
//! ```
//!
//! listens on 127.0.0.1:9100 and forwards to 127.0.0.1:9000 (the local stack's RustFS), at
//! 2,000,000 bytes a second toward it and as fast as it comes back. Start the e2e Pane View with
//! `S3_ENDPOINT=http://127.0.0.1:9100` and the upload URLs it signs go through the proxy. Only
//! bytes pass: the Host header the URL was signed for reaches the store unchanged, so the
//! signatures still hold. It forwards only to this machine.

use std::io::{Read as _, Write as _};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};

/// The most a quiet link may send in one burst.
const BURST: f64 = 32.0 * 1024.0;
const CHUNK: usize = 16 * 1024;

/// A token bucket: `rate` bytes a second, at most [`BURST`] saved up.
struct Bucket {
    rate: f64,
    state: Mutex<(f64, Instant)>,
}

impl Bucket {
    fn new(rate: f64) -> Self {
        Self {
            rate,
            state: Mutex::new((BURST, Instant::now())),
        }
    }

    /// Waits until `bytes` may go out.
    fn take(&self, bytes: usize) {
        let wait = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let (tokens, last) = &mut *state;
            let now = Instant::now();
            *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.rate).min(BURST);
            *last = now;
            // Spent ahead of time: a debt the next taker waits out too, which keeps the total
            // rate however many connections take turns.
            *tokens -= bytes as f64;
            (*tokens < 0.0).then(|| Duration::from_secs_f64(-*tokens / self.rate))
        };
        if let Some(wait) = wait {
            thread::sleep(wait);
        }
    }
}

/// Copies `from` to `to` until either closes, through `bucket` when there is one.
fn pump(mut from: TcpStream, mut to: TcpStream, bucket: Option<&Bucket>) {
    let mut buffer = vec![0; CHUNK];
    loop {
        let read = match from.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if let Some(bucket) = bucket {
            bucket.take(read);
        }
        if to.write_all(&buffer[..read]).is_err() {
            break;
        }
    }
    let _ = to.shutdown(Shutdown::Write);
    let _ = from.shutdown(Shutdown::Read);
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [listen, upstream, rate] = args.as_slice() else {
        bail!("usage: throttle_proxy <listen port> <upstream port> <upload bytes a second>");
    };
    let listen: u16 = listen.parse().context("the listen port")?;
    let upstream: u16 = upstream.parse().context("the upstream port")?;
    let rate: f64 = rate.parse().context("the rate")?;
    anyhow::ensure!(rate > 0.0, "the rate must be above zero");
    let bucket = Arc::new(Bucket::new(rate));
    let listener = TcpListener::bind(("127.0.0.1", listen))?;
    eprintln!("127.0.0.1:{listen} -> 127.0.0.1:{upstream}, uploads at {rate} B/s");
    for client in listener.incoming() {
        let Ok(client) = client else { continue };
        let Ok(server) = TcpStream::connect(("127.0.0.1", upstream)) else {
            continue;
        };
        let _ = client.set_nodelay(true);
        let _ = server.set_nodelay(true);
        let (Ok(client_reader), Ok(server_reader)) = (client.try_clone(), server.try_clone())
        else {
            continue;
        };
        let up = bucket.clone();
        thread::spawn(move || pump(client_reader, server, Some(&up)));
        thread::spawn(move || pump(server_reader, client, None));
    }
    Ok(())
}
