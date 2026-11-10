//! Test support, behind the `test-support` feature: a small Pane View on a local port, and the
//! e2e stack's description for the tests and the bench that run against the real one.
//!
//! [`FakePaneView`] serves the five sync routes with its library in memory. Each request body
//! must have the shape of the bodies `conformance/lockstep-core/wire.json` lists for its route,
//! which Pane View's routes are tested to accept, and may write only into a running sync run.
//! Pane View's other checks of a body stay Pane View's: the fake stands in for the routes'
//! shapes and the storage behind them. Upload URLs are signed with the length and SHA-256 headers
//! (plan 026), the PUT is checked as S3 checks it, and a registration must name stored bytes of
//! its hash. Requests without the token get a 401.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::api::routes;

/// The e2e stack every suite runs against (`e2e/stack.json`): the e2e Pane View, its sync token,
/// and the fixture folders, which `docs/runbooks/e2e.md` sets up.
#[derive(Clone, Debug)]
pub struct E2eStack {
    pub url: String,
    pub sync_token: String,
    /// The archive the stack is seeded with.
    pub archive: PathBuf,
    /// The two-file source the Sync spec pushes.
    pub lockstep_source: PathBuf,
}

impl E2eStack {
    pub fn get() -> Self {
        let stack: Value = serde_json::from_str(include_str!("../../../../../e2e/stack.json"))
            .expect("e2e/stack.json is JSON");
        let text = |value: &Value| {
            value
                .as_str()
                .expect("a string in e2e/stack.json")
                .to_owned()
        };
        let e2e = std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../e2e"))
            .expect("the repository's e2e folder");
        Self {
            url: format!(
                "http://127.0.0.1:{}",
                stack["paneView"]["port"]
                    .as_u64()
                    .expect("a port in e2e/stack.json")
            ),
            sync_token: text(&stack["paneView"]["syncToken"]),
            archive: e2e.join(text(&stack["fixtures"]["archive"])),
            lockstep_source: e2e.join(text(&stack["fixtures"]["lockstepSource"])),
        }
    }
}

/// What the body of each sync request looks like, from the examples in `wire.json`.
struct Wire {
    upload_url: Shape,
    complete_object: Shape,
    delete: Shape,
    create_run: Shape,
    finalize: Shape,
}

static WIRE: LazyLock<Wire> = LazyLock::new(|| {
    let wire: Value =
        serde_json::from_str(include_str!("../../../conformance/lockstep-core/wire.json"))
            .expect("wire.json is JSON");
    let examples = |list: &str, field: &str| {
        Shape::of(
            wire[list]
                .as_array()
                .expect("a list in wire.json")
                .iter()
                .map(|case| &case[field]),
        )
    };
    Wire {
        upload_url: examples("registrations", "uploadUrl"),
        complete_object: examples("registrations", "completeObject"),
        delete: Shape::of([&wire["delete"]]),
        create_run: Shape::of([&wire["createRun"]]),
        finalize: examples("finalize", "body"),
    }
});

/// The JSON shape a body must have: an object's keys, each required when every example has it,
/// and the kind of each value. No other key is allowed.
#[derive(Debug)]
enum Shape {
    Object(BTreeMap<String, (Shape, bool)>),
    String,
    Number,
}

impl Shape {
    fn of<'a>(examples: impl IntoIterator<Item = &'a Value>) -> Self {
        let examples: Vec<&Value> = examples.into_iter().collect();
        match examples[0] {
            Value::Object(_) => {
                let objects: Vec<&Map<String, Value>> = examples
                    .iter()
                    .map(|example| example.as_object().expect("examples of one shape"))
                    .collect();
                let mut keys: Vec<&String> =
                    objects.iter().flat_map(|object| object.keys()).collect();
                keys.sort();
                keys.dedup();
                Self::Object(
                    keys.into_iter()
                        .map(|key| {
                            let values: Vec<&Value> = objects
                                .iter()
                                .filter_map(|object| object.get(key))
                                .collect();
                            let required = values.len() == objects.len();
                            (key.clone(), (Self::of(values), required))
                        })
                        .collect(),
                )
            }
            Value::String(_) => Self::String,
            Value::Number(_) => Self::Number,
            other => panic!("wire.json has no {other} in a body"),
        }
    }

    /// Why `value` does not have this shape, if it does not.
    fn check(&self, value: &Value, at: &str) -> Result<(), String> {
        match (self, value) {
            (Self::String, Value::String(_)) | (Self::Number, Value::Number(_)) => Ok(()),
            (Self::Object(keys), Value::Object(object)) => {
                if let Some(extra) = object.keys().find(|key| !keys.contains_key(*key)) {
                    return Err(format!("{at}{extra} is not part of the body"));
                }
                for (key, (shape, required)) in keys {
                    match object.get(key) {
                        Some(value) => shape.check(value, &format!("{at}{key}."))?,
                        None if *required => return Err(format!("{at}{key} is required")),
                        None => {}
                    }
                }
                Ok(())
            }
            _ => Err(format!("{} has the wrong type", at.trim_end_matches('.'))),
        }
    }
}

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
    /// The finalize body; once there, the run takes no more writes.
    pub outcome: Option<Value>,
}

#[derive(Default)]
struct State {
    library: BTreeMap<String, FakeEntry>,
    objects: HashMap<String, Vec<u8>>,
    runs: Vec<FakeRun>,
    puts: Vec<HashMap<String, String>>,
}

impl State {
    /// Pane View's answer to a write into the run `id` that is not running, if it is not.
    fn refuse_write(&self, id: &Value) -> Option<(u16, Value)> {
        match self
            .runs
            .iter()
            .find(|run| Some(run.id.as_str()) == id.as_str())
        {
            None => Some((404, json!({ "error": "Sync run not found." }))),
            Some(run) if run.outcome.is_some() => {
                Some((409, json!({ "error": "Sync run is not accepting writes." })))
            }
            Some(_) => None,
        }
    }
}

/// The fake server. It stops when dropped.
pub struct FakePaneView {
    address: SocketAddr,
    token: String,
    state: Arc<Mutex<State>>,
    puts: Arc<Gate>,
    put_failure: Arc<Mutex<Option<u16>>>,
    deletes: Arc<Gate>,
    stop: Arc<AtomicBool>,
}

/// The requests of one kind in flight, and the most there have been at once. A test can hold
/// each until a number are in flight together, so a run's concurrency shows without timing it.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Default)]
struct GateState {
    active: usize,
    peak: usize,
    /// Requests wait until this many are in flight; 0 holds none.
    together: usize,
    open: bool,
}

impl Gate {
    /// The longest a request waits for the others, so a run that never sends enough at once
    /// fails its test rather than hanging it.
    const PATIENCE: Duration = Duration::from_secs(10);

    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn hold(&self, together: usize) {
        let mut state = self.lock();
        state.together = together;
        state.open = false;
    }

    fn open(&self) {
        self.lock().open = true;
        self.changed.notify_all();
    }

    fn enter(&self) {
        let mut state = self.lock();
        state.active += 1;
        state.peak = state.peak.max(state.active);
        if state.active >= state.together {
            state.open = true;
            self.changed.notify_all();
        }
        let deadline = Instant::now() + Self::PATIENCE;
        while !state.open {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn leave(&self) {
        self.lock().active -= 1;
    }

    fn peak(&self) -> usize {
        self.lock().peak
    }
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
            puts: Arc::default(),
            put_failure: Arc::default(),
            deletes: Arc::default(),
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
            puts: self.puts.clone(),
            put_failure: self.put_failure.clone(),
            deletes: self.deletes.clone(),
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

    /// The headers of each upload, lower-cased.
    pub fn uploads(&self) -> Vec<HashMap<String, String>> {
        self.lock().puts.clone()
    }

    /// The most uploads there have been in flight at once.
    pub fn peak_uploads(&self) -> usize {
        self.puts.peak()
    }

    /// Holds each upload until `together` are in flight at once, then answers them all.
    pub fn hold_uploads(&self, together: usize) {
        self.puts.hold(together);
    }

    /// Answers every upload with this status, as an overloaded store would.
    pub fn fail_uploads(&self, status: u16) {
        *self
            .put_failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(status);
    }

    /// Holds each delete until `together` are in flight at once, then answers them all.
    pub fn hold_deletes(&self, together: usize) {
        self.deletes.hold(together);
    }

    /// The most deletes there have been in flight at once.
    pub fn peak_deletes(&self) -> usize {
        self.deletes.peak()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for FakePaneView {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.puts.open();
        self.deletes.open();
        // Wakes the accept loop so it sees the stop.
        let _ = TcpStream::connect(self.address);
    }
}

#[derive(Clone)]
struct Shared {
    address: SocketAddr,
    token: String,
    state: Arc<Mutex<State>>,
    puts: Arc<Gate>,
    put_failure: Arc<Mutex<Option<u16>>>,
    deletes: Arc<Gate>,
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
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Service Unavailable",
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
        let delete = route == routes::COMPLETE_OBJECT && body["action"] == "delete";
        if delete {
            self.deletes.enter();
        }
        let (status, answer) = self.route(&request.method, &route, &body);
        if delete {
            self.deletes.leave();
        }
        respond(&stream, status, &answer);
    }

    fn route(&self, method: &str, route: &str, body: &Value) -> (u16, Value) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let wire = &*WIRE;
        let bad = |error: String| (400, json!({ "error": error }));
        let finalized_run = route
            .strip_prefix(routes::RUNS)
            .and_then(|rest| rest.strip_prefix('/'))
            .and_then(|rest| rest.strip_suffix("/complete"))
            .filter(|id| route == routes::complete_run(id));
        match (method, route) {
            ("GET", routes::SNAPSHOT) => {
                let entries: Vec<Value> = state
                    .library
                    .iter()
                    .map(|(path, entry)| {
                        json!({ "path": path, "sha256": entry.sha256, "size": entry.size })
                    })
                    .collect();
                (200, json!({ "entries": entries }))
            }
            ("POST", routes::RUNS) => {
                if let Err(error) = wire.create_run.check(body, "") {
                    return bad(error);
                }
                let id = format!("00000000-0000-4000-8000-{:012}", state.runs.len() + 1);
                state.runs.push(FakeRun {
                    id: id.clone(),
                    source_root: body["sourceRoot"].as_str().unwrap_or_default().to_owned(),
                    outcome: None,
                });
                (200, json!({ "syncRunId": id }))
            }
            ("POST", routes::UPLOAD_URL) => {
                if let Err(error) = wire.upload_url.check(body, "") {
                    return bad(error);
                }
                let sha256 = body["sha256"].as_str().unwrap_or_default();
                let size = body["size"].as_u64().unwrap_or_default();
                let object_key = format!("originals/{}", sha256.to_ascii_lowercase());
                (
                    200,
                    json!({
                        "headers": {
                            "Content-Length": size.to_string(),
                            "Content-Type": body["contentType"],
                            "x-amz-checksum-sha256": base64_of_hex(sha256),
                            "x-amz-meta-sha256": sha256.to_ascii_lowercase(),
                        },
                        "objectKey": object_key,
                        "uploadUrl": format!(
                            "http://{}/upload/{object_key}?X-Amz-SignedHeaders=content-length",
                            self.address
                        ),
                    }),
                )
            }
            ("POST", routes::COMPLETE_OBJECT) if body["action"] == "delete" => {
                if let Err(error) = wire.delete.check(body, "") {
                    return bad(error);
                }
                if let Some(refused) = state.refuse_write(&body["syncRunId"]) {
                    return refused;
                }
                let path = body["logicalPath"].as_str().unwrap_or_default();
                state.library.remove(path);
                (200, json!({}))
            }
            ("POST", routes::COMPLETE_OBJECT) => {
                if let Err(error) = wire.complete_object.check(body, "") {
                    return bad(error);
                }
                if let Some(refused) = state.refuse_write(&body["syncRunId"]) {
                    return refused;
                }
                let object_key = body["objectKey"].as_str().unwrap_or_default();
                let Some(object) = state.objects.get(object_key) else {
                    return bad("object was not uploaded".to_owned());
                };
                let entry = FakeEntry {
                    sha256: hex(&Sha256::digest(object)),
                    size: object.len() as u64,
                };
                if Some(entry.sha256.as_str()) != body["sha256"].as_str() {
                    return bad("sha256 does not match storage".to_owned());
                }
                let path = body["logicalPath"].as_str().unwrap_or_default().to_owned();
                state.library.insert(path, entry);
                (200, json!({}))
            }
            ("POST", _) if finalized_run.is_some() => {
                if let Err(error) = wire.finalize.check(body, "") {
                    return bad(error);
                }
                let id = finalized_run.unwrap_or_default();
                match state.runs.iter_mut().find(|run| run.id == id) {
                    Some(run) => {
                        run.outcome = Some(body.clone());
                        (200, json!({}))
                    }
                    None => (404, json!({ "error": "Sync run not found." })),
                }
            }
            _ => (404, json!({ "error": "not found" })),
        }
    }

    /// The signed PUT, checked as S3 checks a presigned upload: the declared length, and the
    /// bytes against the declared SHA-256.
    fn put(&self, object_key: &str, request: &Request) -> (u16, Value) {
        self.puts.enter();
        let failure = *self
            .put_failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let answer = (|| {
            if let Some(status) = failure {
                return Some((status, json!({ "error": "SlowDown" })));
            }
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
        self.puts.leave();
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
