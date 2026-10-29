//! A small Pane View for tests, behind the `test-support` feature: the five sync routes on a
//! local port, its library in memory, and the signed upload checked as S3 checks it.
//!
//! It answers what Pane View answers (`apps/pane-view/src/routes/api.sync.*.ts`): the snapshot,
//! sync runs, upload URLs signed with the length and SHA-256 headers (plan 026), the PUT, and
//! complete-object for uploads and deletes. Requests without the token get a 401. It is a
//! stand-in for the routes the generated schema names, not for Pane View's storage or database.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

/// One library entry: what the snapshot lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeEntry {
    pub sha256: String,
    pub size: u64,
}

/// A sync run as the fake recorded it.
#[derive(Clone, Debug, PartialEq)]
pub struct FakeRun {
    pub id: String,
    pub source_root: String,
    pub outcome: Option<Value>,
}

#[derive(Default)]
struct State {
    library: BTreeMap<String, FakeEntry>,
    objects: HashMap<String, Vec<u8>>,
    runs: Vec<FakeRun>,
    requests: Vec<String>,
    puts: Vec<HashMap<String, String>>,
}

/// The fake server. It stops when dropped.
pub struct FakePaneView {
    address: SocketAddr,
    token: String,
    state: Arc<Mutex<State>>,
    active_puts: Arc<AtomicUsize>,
    peak_puts: Arc<AtomicUsize>,
    put_delay: Arc<Mutex<Duration>>,
    stop: Arc<AtomicBool>,
}

impl FakePaneView {
    /// Starts a server that accepts `token`.
    pub fn start(token: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the fake Pane View");
        let address = listener.local_addr().expect("the fake's address");
        let server = Self {
            address,
            token: token.to_owned(),
            state: Arc::default(),
            active_puts: Arc::default(),
            peak_puts: Arc::default(),
            put_delay: Arc::default(),
            stop: Arc::default(),
        };
        let shared = server.shared();
        let stop = server.stop.clone();
        thread::Builder::new()
            .name("fake pane view".to_owned())
            .spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let shared = shared.clone();
                    thread::spawn(move || shared.serve(stream));
                }
            })
            .expect("start the fake Pane View");
        server
    }

    fn shared(&self) -> Shared {
        Shared {
            address: self.address,
            token: self.token.clone(),
            state: self.state.clone(),
            active_puts: self.active_puts.clone(),
            peak_puts: self.peak_puts.clone(),
            put_delay: self.put_delay.clone(),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Puts an entry in the library, as an earlier push would have.
    pub fn seed(&self, path: &str, bytes: &[u8]) {
        let sha256 = hex(&Sha256::digest(bytes));
        self.lock().library.insert(
            path.to_owned(),
            FakeEntry {
                sha256,
                size: bytes.len() as u64,
            },
        );
    }

    pub fn library(&self) -> BTreeMap<String, FakeEntry> {
        self.lock().library.clone()
    }

    pub fn runs(&self) -> Vec<FakeRun> {
        self.lock().runs.clone()
    }

    /// Every request as `METHOD /path`, in arrival order.
    pub fn requests(&self) -> Vec<String> {
        self.lock().requests.clone()
    }

    /// The headers of each upload, lower-cased.
    pub fn uploads(&self) -> Vec<HashMap<String, String>> {
        self.lock().puts.clone()
    }

    /// The most uploads that were in flight at once.
    pub fn peak_uploads(&self) -> usize {
        self.peak_puts.load(Ordering::SeqCst)
    }

    /// Holds each upload this long before answering, so concurrency shows.
    pub fn delay_uploads(&self, delay: Duration) {
        *self
            .put_delay
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = delay;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for FakePaneView {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the stop.
        let _ = TcpStream::connect(self.address);
    }
}

#[derive(Clone)]
struct Shared {
    address: SocketAddr,
    token: String,
    state: Arc<Mutex<State>>,
    active_puts: Arc<AtomicUsize>,
    peak_puts: Arc<AtomicUsize>,
    put_delay: Arc<Mutex<Duration>>,
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let mut body = Vec::new();
    if let Some(length) = headers.get("content-length") {
        body.resize(length.parse().ok()?, 0);
        reader.read_exact(&mut body).ok()?;
    } else if headers
        .get("transfer-encoding")
        .is_some_and(|encoding| encoding.eq_ignore_ascii_case("chunked"))
    {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).ok()?;
            let size = usize::from_str_radix(size.trim(), 16).ok()?;
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).ok()?;
            if size == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..size]);
        }
    }
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn respond(mut stream: &TcpStream, status: u16, body: &Value) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        _ => "Not Found",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.flush();
}

impl Shared {
    fn serve(&self, stream: TcpStream) {
        let Some(request) = read_request(&stream) else {
            return;
        };
        let route = request
            .path
            .split('?')
            .next()
            .unwrap_or_default()
            .to_owned();
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .requests
            .push(format!("{} {route}", request.method));

        if request.method == "PUT" && route.starts_with("/upload/") {
            let (status, body) = self.put(&route["/upload/".len()..], &request);
            respond(&stream, status, &body);
            return;
        }
        let authorized = request
            .headers
            .get("authorization")
            .is_some_and(|value| *value == format!("Bearer {}", self.token));
        if !authorized {
            respond(&stream, 401, &json!({ "error": "Unauthorized" }));
            return;
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let (status, answer) = self.route(&request.method, &route, &body);
        respond(&stream, status, &answer);
    }

    fn route(&self, method: &str, route: &str, body: &Value) -> (u16, Value) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match (method, route) {
            ("GET", "/api/sync/snapshot") => {
                let entries: Vec<Value> = state
                    .library
                    .iter()
                    .map(|(path, entry)| {
                        json!({ "path": path, "sha256": entry.sha256, "size": entry.size })
                    })
                    .collect();
                (200, json!({ "entries": entries, "status": "database" }))
            }
            ("POST", "/api/sync/runs") => {
                let id = format!("00000000-0000-4000-8000-{:012}", state.runs.len() + 1);
                state.runs.push(FakeRun {
                    id: id.clone(),
                    source_root: body["sourceRoot"].as_str().unwrap_or_default().to_owned(),
                    outcome: None,
                });
                (200, json!({ "status": "database", "syncRunId": id }))
            }
            ("POST", "/api/sync/upload-url") => {
                let sha256 = body["sha256"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let size = body["size"].as_f64().unwrap_or_default() as u64;
                let filename = body["filename"].as_str().unwrap_or_default();
                let extension = filename.rsplit('.').next().unwrap_or_default();
                let object_key = format!("originals/{sha256}.{extension}");
                let checksum = base64_of_hex(&sha256);
                (
                    200,
                    json!({
                        "headers": {
                            "Content-Length": size.to_string(),
                            "Content-Type": body["contentType"],
                            "x-amz-checksum-sha256": checksum,
                            "x-amz-meta-sha256": sha256,
                        },
                        "maxUploadBytes": 5_368_709_120u64,
                        "objectKey": object_key,
                        "status": "signed-url-ready",
                        "uploadUrl": format!(
                            "http://{}/upload/{object_key}?X-Amz-SignedHeaders=content-length",
                            self.address
                        ),
                    }),
                )
            }
            ("POST", "/api/sync/complete-object") => {
                let path = body["logicalPath"].as_str().unwrap_or_default().to_owned();
                if body["action"] == "delete" {
                    state.library.remove(&path);
                    return (200, json!({ "status": "database" }));
                }
                let object_key = body["objectKey"].as_str().unwrap_or_default();
                let Some(object) = state.objects.get(object_key) else {
                    return (400, json!({ "error": "object was not uploaded" }));
                };
                let entry = FakeEntry {
                    sha256: hex(&Sha256::digest(object)),
                    size: object.len() as u64,
                };
                if Some(entry.sha256.as_str()) != body["sha256"].as_str() {
                    return (400, json!({ "error": "sha256 does not match storage" }));
                }
                state.library.insert(path, entry);
                (200, json!({ "status": "database" }))
            }
            ("POST", route)
                if route.starts_with("/api/sync/runs/") && route.ends_with("/complete") =>
            {
                let id = &route["/api/sync/runs/".len()..route.len() - "/complete".len()];
                match state.runs.iter_mut().find(|run| run.id == id) {
                    Some(run) => {
                        run.outcome = Some(body.clone());
                        (200, json!({ "status": "database" }))
                    }
                    None => (404, json!({ "error": "no such run" })),
                }
            }
            _ => (404, json!({ "error": "not found" })),
        }
    }

    /// The signed PUT, checked as S3 checks a presigned upload: the declared length, and the
    /// bytes against the declared SHA-256.
    fn put(&self, object_key: &str, request: &Request) -> (u16, Value) {
        let active = self.active_puts.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak_puts.fetch_max(active, Ordering::SeqCst);
        let delay = *self
            .put_delay
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        thread::sleep(delay);
        let answer = (|| {
            let declared: usize = request.headers.get("content-length")?.parse().ok()?;
            if declared != request.body.len() {
                return Some((400, json!({ "error": "IncompleteBody" })));
            }
            let checksum = request.headers.get("x-amz-checksum-sha256")?;
            let actual = base64_of_hex(&hex(&Sha256::digest(&request.body)));
            if *checksum != actual {
                return Some((
                    400,
                    json!({ "error": "BadDigest", "declared": checksum, "actual": actual }),
                ));
            }
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.puts.push(request.headers.clone());
            state
                .objects
                .insert(object_key.to_owned(), request.body.clone());
            Some((200, Value::Null))
        })()
        .unwrap_or((400, json!({ "error": "missing signed headers" })));
        self.active_puts.fetch_sub(1, Ordering::SeqCst);
        answer
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// S3's `x-amz-checksum-sha256`: the digest's bytes in base64.
fn base64_of_hex(hex: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = (0..hex.len() / 2)
        .filter_map(|at| u8::from_str_radix(hex.get(at * 2..at * 2 + 2)?, 16).ok())
        .collect();
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                encoded.push(ALPHABET[(triple >> (18 - index * 6) & 63) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}
