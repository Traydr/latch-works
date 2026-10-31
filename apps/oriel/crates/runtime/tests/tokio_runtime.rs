//! The tokio thread: `reqwest` runs on it against a local server and GPUI's executors await the
//! answer; dropping a task aborts its request; stopping the runtime cancels what is left.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::{SocketAddr, TcpListener};
use std::sync::mpsc;
use std::time::Duration;

use gpui_kit::{AppContext as _, TestAppContext};
use oriel_runtime::{Cancelled, TokioRuntime};

/// A server on a free local port that answers each of `requests` connections with the request
/// line it read, so a test sees its request arrived as sent.
fn echo_server(requests: usize) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(requests) {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap() == 0 || header == "\r\n" {
                    break;
                }
            }
            let body = request_line.trim_end();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    address
}

#[gpui_kit::test]
async fn gpui_awaits_requests_made_on_the_tokio_thread(cx: &mut TestAppContext) {
    // The answer comes from other threads, so the test scheduler has to be allowed to wait.
    cx.executor().allow_parking();
    let runtime = TokioRuntime::start("oriel-http-test").unwrap();
    let address = echo_server(2);

    let handle = runtime.handle();
    let from_foreground = cx
        .spawn(async move |_| {
            handle
                .spawn(async move {
                    reqwest::get(format!("http://{address}/catalog?page=1"))
                        .await?
                        .error_for_status()?
                        .text()
                        .await
                })
                .await
        })
        .await;
    assert_eq!(
        from_foreground.unwrap().unwrap(),
        "GET /catalog?page=1 HTTP/1.1"
    );

    let handle = runtime.handle();
    let from_background = cx
        .background_spawn(async move {
            handle
                .spawn(async move {
                    let client = reqwest::Client::new();
                    client
                        .post(format!("http://{address}/push"))
                        .body("payload")
                        .send()
                        .await?
                        .text()
                        .await
                })
                .await
        })
        .await;
    assert_eq!(from_background.unwrap().unwrap(), "POST /push HTTP/1.1");
}

/// Sends on a channel when dropped, wherever that happens.
struct Dropped(mpsc::Sender<()>);

impl Drop for Dropped {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[test]
fn dropping_a_task_aborts_its_future() {
    let runtime = TokioRuntime::start("oriel-http-abort-test").unwrap();
    let (dropped, aborted) = mpsc::channel();
    let (started, running) = mpsc::channel();
    let task = runtime.spawn(async move {
        let _dropped = Dropped(dropped);
        started.send(()).unwrap();
        tokio::time::sleep(Duration::from_secs(3600)).await;
    });
    running.recv_timeout(Duration::from_secs(5)).unwrap();

    drop(task);
    aborted
        .recv_timeout(Duration::from_secs(5))
        .expect("the future is dropped on the tokio thread");
}

#[test]
fn stopping_the_runtime_cancels_its_tasks() {
    let runtime = TokioRuntime::start("oriel-http-stop-test").unwrap();
    let task = runtime.spawn(std::future::pending::<()>());
    drop(runtime);

    let error = futures::executor::block_on(task).unwrap_err();
    assert!(error.is::<Cancelled>(), "{error}");
}
