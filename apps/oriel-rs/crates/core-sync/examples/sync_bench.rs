//! Times Sync's runs headless against a local Pane View, on the app's own tokio thread
//! (`oriel_runtime::TokioRuntime`), so plan, push and prune can be measured without a click.
//!
//! ```sh
//! cargo run --release -p oriel-core-sync --example sync_bench -- plan <source> <hash-cache> all
//! cargo run --release -p oriel-core-sync --example sync_bench -- push <source> <hash-cache> [3]
//! cargo run --release -p oriel-core-sync --example sync_bench -- prune <source> <hash-cache>
//! cargo run --release -p oriel-core-sync --example sync_bench -- snapshot
//! ```
//!
//! `plan` takes the hash mode (`none`, `all` or `remote-aware`) and `offline` to plan against an
//! empty remote; `push` takes the upload queue's width. Each run prints one JSON line: its wall
//! time, the time of each status line the run reported, and how many events it sent, which is
//! what Sync's window has to fold in. The URL is the e2e suite's Pane View unless
//! `ORIEL_RS_SYNC_STACK_URL` names another on this machine; the bench refuses any other host, so
//! it can never push anywhere but the local stack.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context as _, bail};
use futures::StreamExt as _;
use oriel_core_sync::{
    ApiTarget, HashMode, Observer, PaneViewClient, PlanOptions, PruneOptions, PushOptions,
    RunEvent, cache_root, plan_sync, prune_deleted, push_changes,
};
use oriel_runtime::{CancelToken, TokioRuntime};

/// The e2e suite's Pane View and sync token (`e2e/src/env.ts`), not a secret.
const E2E_URL: &str = "http://127.0.0.1:3100";
const E2E_TOKEN: &str = "e2e-sync-token-0123456789abcdef";

/// What the observer saw: each status line's time, and how many events of each kind.
#[derive(Default)]
struct Seen {
    marks: Vec<(f64, String)>,
    counts: BTreeMap<&'static str, usize>,
    /// Per item of a push: when it started, asked for its upload URL, recorded its ingest and
    /// ended, from the item events and the stage lines the push reports.
    items: BTreeMap<usize, [Option<f64>; 4]>,
}

impl Seen {
    fn stage(&mut self, current: usize, stage: usize, at: f64) {
        self.items.entry(current).or_default()[stage].get_or_insert(at);
    }

    /// The median and the sum of each stage over the items: preparing (stat, cache, hash),
    /// registering and uploading, recording the ingest.
    fn stages(&self) -> String {
        let names = ["prepare", "register-upload", "ingest"];
        let mut parts = Vec::new();
        for (stage, name) in names.iter().enumerate() {
            let mut spans: Vec<f64> = self
                .items
                .values()
                .filter_map(|times| Some(times[stage + 1]? - times[stage]?))
                .collect();
            if spans.is_empty() {
                continue;
            }
            spans.sort_by(f64::total_cmp);
            let sum: f64 = spans.iter().sum();
            parts.push(format!(
                r#""{name}":{{"p50":{:.2},"p90":{:.2},"sum":{sum:.0}}}"#,
                spans[spans.len() / 2],
                spans[spans.len() * 9 / 10]
            ));
        }
        parts.join(",")
    }
}

/// The item number of a push's stage line, `[current/total] …`.
fn item_number(message: &str) -> Option<usize> {
    message.strip_prefix('[')?.split('/').next()?.parse().ok()
}

/// An observer as Sync's window has one: each event goes down an unbounded channel, and a
/// thread of its own reads them off, as the window does, so a run pays only for the send.
fn observer(started: Instant) -> (Observer, std::thread::JoinHandle<Seen>) {
    let (sender, mut events) = futures::channel::mpsc::unbounded::<(f64, RunEvent)>();
    let reader = std::thread::spawn(move || {
        let mut seen = Seen::default();
        while let Some((at, event)) = futures::executor::block_on(events.next()) {
            let kind = match &event {
                RunEvent::Status(message) => {
                    // Per-item lines would drown the stages; keep the run's own.
                    if !message.starts_with('[') {
                        seen.marks.push((at, message.clone()));
                    } else if let Some(current) = item_number(message) {
                        if message.ends_with("(requesting upload URL)") {
                            seen.stage(current, 1, at);
                        } else if message.ends_with("(recording ingest)") {
                            seen.stage(current, 2, at);
                        }
                    }
                    "status"
                }
                RunEvent::ScanProgress(_) => "scan-progress",
                RunEvent::ItemStart { current, .. } => {
                    seen.stage(*current, 0, at);
                    "item-start"
                }
                RunEvent::ItemSuccess { current, .. } => {
                    seen.stage(*current, 3, at);
                    "item-success"
                }
                RunEvent::ItemFailure { .. } => "item-failure",
                RunEvent::ItemSkipped { .. } => "item-skipped",
                RunEvent::ItemsQueued { .. } => "items-queued",
                RunEvent::Complete(_) => "complete",
                RunEvent::Cancelled => "cancelled",
            };
            *seen.counts.entry(kind).or_default() += 1;
        }
        seen
    });
    let observer: Observer = Arc::new(move |event: RunEvent| {
        let _ = sender.unbounded_send((started.elapsed().as_secs_f64() * 1e3, event));
    });
    (observer, reader)
}

fn target() -> anyhow::Result<ApiTarget> {
    let url = std::env::var("ORIEL_RS_SYNC_STACK_URL").unwrap_or_else(|_| E2E_URL.to_owned());
    let host = host_of(&url)?;
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        bail!("{url} is not on this machine; the bench only syncs to the local stack");
    }
    Ok(ApiTarget {
        url,
        token: std::env::var("ORIEL_RS_SYNC_STACK_TOKEN").unwrap_or_else(|_| E2E_TOKEN.to_owned()),
    })
}

/// The host of `url`, without pulling in a URL parser of the bench's own.
fn host_of(url: &str) -> anyhow::Result<String> {
    let rest = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .context("the URL has no scheme")?;
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(v6) => format!("[{}]", v6.split(']').next().unwrap_or_default()),
        None => authority.split(':').next().unwrap_or_default().to_owned(),
    };
    Ok(host)
}

fn hash_mode(name: &str) -> anyhow::Result<HashMode> {
    Ok(match name {
        "none" => HashMode::None,
        "all" => HashMode::All,
        "remote-aware" => HashMode::RemoteAware,
        other => bail!("unknown hash mode {other}"),
    })
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args
        .first()
        .context("usage: sync_bench <plan|push|prune|snapshot> …")?;
    let runtime = TokioRuntime::start("sync-bench")?;
    let api = target()?;
    let client = PaneViewClient::new(api.clone())?;
    let cancel = CancelToken::new();
    let started = Instant::now();
    let (watcher, reader) = observer(started);

    let summary = match mode.as_str() {
        "snapshot" => {
            drop(watcher);
            let entries = futures::executor::block_on(
                runtime.spawn(async move { client.fetch_snapshot(None).await }),
            )??;
            format!(r#""entries":{}"#, entries.len())
        }
        "plan" => {
            let (source, cache) = folders(&args)?;
            let hash_mode = hash_mode(args.get(3).map_or("none", String::as_str))?;
            let offline = args.iter().any(|arg| arg == "offline");
            // `repeat=N` plans N times in one process, long enough for `sample` to profile.
            let repeat = args
                .iter()
                .find_map(|arg| arg.strip_prefix("repeat="))
                .map_or(Ok(1), str::parse::<usize>)?;
            let plan = futures::executor::block_on(runtime.spawn(async move {
                let mut plan = None;
                for _ in 0..repeat.max(1) {
                    plan = Some(
                        plan_sync(
                            PlanOptions {
                                source_root: source.clone(),
                                hash_cache_root: cache_root(&cache),
                                hash_mode,
                                directory_concurrency: None,
                                file_concurrency: None,
                            },
                            (!offline).then_some(&client),
                            Some(&watcher),
                            &cancel,
                        )
                        .await?,
                    );
                }
                anyhow::Ok(plan.expect("planned at least once"))
            }))??;
            format!(
                r#""files":{},"upload":{},"update":{},"keep":{},"delete":{},"bytes":{}"#,
                plan.total_files,
                plan.counts.upload,
                plan.counts.update,
                plan.counts.keep,
                plan.counts.delete,
                plan.total_bytes
            )
        }
        "push" => {
            let (source, cache) = folders(&args)?;
            let width = args.get(3).map(|width| width.parse()).transpose()?;
            let result = futures::executor::block_on(runtime.spawn(async move {
                push_changes(
                    PushOptions {
                        api,
                        source_root: source,
                        hash_cache_root: cache_root(&cache),
                        hash_mode: None,
                        max_changes: None,
                        plan: None,
                        upload_concurrency: width,
                    },
                    &client,
                    Some(&watcher),
                    &cancel,
                )
                .await
            }))??;
            format!(
                r#""pushed":{},"failed":{},"bytes":{}"#,
                result.pushed,
                result.failed,
                result.plan.push_bytes()
            )
        }
        "prune" => {
            let (source, cache) = folders(&args)?;
            let result = futures::executor::block_on(runtime.spawn(async move {
                let plan = plan_sync(
                    PlanOptions {
                        source_root: source,
                        hash_cache_root: cache_root(&cache),
                        hash_mode: HashMode::None,
                        directory_concurrency: None,
                        file_concurrency: None,
                    },
                    Some(&client),
                    None,
                    &cancel,
                )
                .await?;
                prune_deleted(
                    PruneOptions {
                        api,
                        max_changes: None,
                        plan,
                    },
                    &client,
                    Some(&watcher),
                    &cancel,
                )
                .await
            }))??;
            format!(
                r#""pruned":{},"skipped":{},"failed":{}"#,
                result.pruned, result.skipped, result.failed
            )
        }
        other => {
            drop(watcher);
            bail!("unknown run {other}")
        }
    };

    let elapsed = started.elapsed().as_secs_f64() * 1e3;
    // Every run's future has ended, and with it every sender, so the reader has them all.
    let seen = reader.join().expect("the event reader");
    let marks: Vec<String> = seen
        .marks
        .iter()
        .map(|(at, message)| format!("[{at:.1},{}]", serde_json::to_string(message).unwrap()))
        .collect();
    let counts: Vec<String> = seen
        .counts
        .iter()
        .map(|(kind, count)| format!(r#""{kind}":{count}"#))
        .collect();
    println!(
        r#"{{"run":"{mode}","ms":{elapsed:.1},{summary},"stages":{{{}}},"events":{{{}}},"marks":[{}]}}"#,
        seen.stages(),
        counts.join(","),
        marks.join(",")
    );
    Ok(())
}

fn folders(args: &[String]) -> anyhow::Result<(PathBuf, PathBuf)> {
    let source = args.get(1).context("the source folder")?;
    let cache = args.get(2).context("the hash cache folder")?;
    Ok((PathBuf::from(source), PathBuf::from(cache)))
}
