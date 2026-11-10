//! `doctor.json`: the doctor's checks, with the temp folder as `<root>` and a loopback port as
//! `<address>`.

use std::fs;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;

use oriel_runtime::{CancelToken, TokioRuntime};
use serde::Deserialize;

use super::read_vectors;
use crate::doctor::{DoctorCheck, DoctorOptions, doctor};
use crate::events::{Observer, RunEvent};

#[derive(Deserialize)]
struct DoctorVectors {
    cases: Vec<DoctorCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCase {
    name: String,
    options: DoctorCaseOptions,
    api: Option<DoctorApi>,
    checks: Vec<DoctorCheck>,
    ok: bool,
    summary: DoctorSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCaseOptions {
    source_root: Option<String>,
    api_url: Option<String>,
    api_token: Option<String>,
}

/// The loopback port a case points the doctor at, written `<address>` in it.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum DoctorApi {
    /// Nothing listens on it.
    Closed,
    /// It answers every request with this status and body.
    Answer { status: u16, body: String },
}

/// A loopback address serving `api`, for as long as the test runs.
fn serve_doctor_api(api: &DoctorApi) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    if let DoctorApi::Answer { status, body } = api {
        let response = format!(
            "HTTP/1.1 {status} Answer\r\ncontent-type: text/plain\r\ncontent-length: {}\r\n\
             connection: close\r\n\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            for mut stream in listener.incoming().map_while(Result::ok) {
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let _ = stream.write_all(response.as_bytes());
            }
        });
    }
    address
}

#[derive(Deserialize, Debug, PartialEq)]
struct DoctorSummary {
    message: String,
    status: String,
    failed: usize,
}

#[test]
#[cfg_attr(
    windows,
    ignore = "the vectors hold the POSIX paths Node writes on macOS"
)]
fn checks_as_lockstep_cores_doctor_does() {
    let vectors: DoctorVectors = read_vectors("doctor.json");
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("doctor");
    fs::create_dir_all(root.join("archive")).unwrap();
    fs::write(root.join("file.jpg"), "x").unwrap();
    let root_text = root.to_string_lossy().into_owned();
    let runtime = TokioRuntime::start("doctor-vectors").unwrap();

    for case in vectors.cases {
        let address = case
            .api
            .as_ref()
            .map_or_else(|| "<address>".to_owned(), serve_doctor_api);
        let summary = std::sync::Arc::new(std::sync::Mutex::new(None));
        let recorded = summary.clone();
        let observer: Observer = std::sync::Arc::new(move |event| {
            if let RunEvent::Complete(summary) = event {
                *recorded.lock().unwrap() = Some(DoctorSummary {
                    message: summary.message.unwrap_or_default(),
                    status: summary.status.as_str().to_owned(),
                    failed: summary.failed,
                });
            }
        });
        let options = DoctorOptions {
            source_root: case
                .options
                .source_root
                .map(|root| root.replace("<root>", &root_text)),
            api_url: case
                .options
                .api_url
                .map(|url| url.replace("<address>", &address)),
            api_token: case.options.api_token,
        };
        let result = futures::executor::block_on(
            runtime
                .spawn(async move { doctor(options, Some(&observer), &CancelToken::new()).await }),
        )
        .unwrap();
        let checks: Vec<_> = result
            .checks
            .into_iter()
            .map(|mut check| {
                check.detail = check.detail.map(|detail| {
                    detail
                        .replace(&root_text, "<root>")
                        .replace(&address, "<address>")
                });
                check
            })
            .collect();
        assert_eq!(checks, case.checks, "{}", case.name);
        assert_eq!(result.ok, case.ok, "{}", case.name);
        assert_eq!(
            summary.lock().unwrap().take(),
            Some(case.summary),
            "{}",
            case.name
        );
    }
}
