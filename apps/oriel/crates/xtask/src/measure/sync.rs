//! Sync's row: `oriel-core-sync`'s `sync_bench` example plans, then pushes, the smoke fixture
//! into a Pane View on this Mac, as Phase 9's `sync-timer` did, each round with a fresh hash
//! cache.
//!
//! It pushes into the target as it finds it. Phase 9 pushed into an empty one, restarting
//! `e2e/scripts/start-pane-view.ts` (which drops and recreates `latch_works_e2e`) before each
//! run; the plan's counts in the table show which this was.

use std::ffi::OsString;
use std::fs;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use super::process::{self, Spec};
use super::{Outcome, Settings, Turn};

/// The e2e stack's sync token (`e2e/src/env.ts`), which the local Pane View accepts.
pub const E2E_TOKEN: &str = "e2e-sync-token-0123456789abcdef";
/// Where to look beside an app's binary for its own `sync_bench` example.
pub const SYNC_BENCH: &[&str] = &["examples/sync_bench", "sync_bench"];

/// A Pane View to push to, checked to be on this Mac.
pub struct Target {
    pub url: String,
    pub token: String,
}

impl Target {
    pub fn new(url: &str, token: String) -> Result<Self> {
        check_local(url)?;
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            token,
        })
    }
}

/// Refuses any URL but plain `http(s)://127.0.0.1` or `http(s)://localhost`, with an optional
/// port and path: Sync must never push to Railway or anywhere else off this Mac (plan 063,
/// ground rules). Credentials, other hosts that merely start with one of these, and other
/// loopback spellings are refused rather than reasoned about.
pub fn check_local(url: &str) -> Result<()> {
    let refuse = || anyhow::anyhow!("--sync-url {url}: only http://127.0.0.1 or localhost");
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(refuse)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return Err(refuse());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if !(host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost")) {
        return Err(refuse());
    }
    if let Some(port) = port
        && (port.is_empty() || port.parse::<u16>().is_err())
    {
        return Err(refuse());
    }
    Ok(())
}

pub fn run(turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    let target = settings.sync.as_ref().context("no --sync-url")?;
    check_local(&target.url)?;
    let bench = turn
        .app
        .sibling(SYNC_BENCH)
        .or_else(|| settings.sync_bench.clone())
        .context("no sync_bench to run")?;
    let cache = turn.folder.join("sync-hash-cache");
    let _ = fs::remove_dir_all(&cache);
    fs::create_dir_all(&cache)?;

    let mut runs = serde_json::Map::new();
    for mode in ["plan", "push"] {
        let stdout = turn.folder.join(format!("sync-{mode}.out"));
        // The plan reads no hashes, as the scorecard's timer did; the push plans again against
        // the remote, as Sync and the Lockstep CLI push.
        let mut args: Vec<OsString> = vec![
            mode.into(),
            settings.sync_source.clone().into(),
            cache.clone().into(),
        ];
        if mode == "plan" {
            args.push("none".into());
        }
        let mut env = settings.env.clone();
        env.push((
            "ORIEL_SYNC_STACK_URL".to_owned(),
            OsString::from(&target.url),
        ));
        env.push((
            "ORIEL_SYNC_STACK_TOKEN".to_owned(),
            OsString::from(&target.token),
        ));
        let mut launched = process::launch(Spec {
            program: &bench,
            args,
            env,
            cwd: &turn.folder,
            stdout: Some(stdout.clone()),
            stderr: turn.folder.join(format!("sync-{mode}.stderr")),
        })?;
        if !launched.wait_up_to(Duration::from_secs(600), Duration::from_millis(20), |_| {}) {
            launched.stop(Duration::from_secs(5));
            bail!("sync_bench {mode} took over 10 minutes");
        }
        let exit = launched.exit_code();
        let line: Value = fs::read_to_string(&stdout)?
            .lines()
            .find_map(|line| serde_json::from_str(line).ok())
            .with_context(|| format!("sync_bench {mode} printed no result (exit {exit:?})"))?;
        runs.insert(mode.to_owned(), line);
    }

    let mut outcome = Outcome::default();
    let field = |mode: &str, key: &str| runs[mode][key].as_f64().unwrap_or(f64::NAN);
    outcome.metric("sync.plan_ms", "Sync: plan (ms)", field("plan", "ms"));
    outcome.metric("sync.push_ms", "Sync: push (ms)", field("push", "ms"));
    for (key, label) in [
        ("files", "files planned"),
        ("upload", "uploads planned"),
        ("keep", "keeps planned"),
    ] {
        outcome.metric(
            format!("sync.plan.{key}"),
            format!("Sync: {label}"),
            field("plan", key),
        );
    }
    outcome.metric("sync.pushed", "Sync: files pushed", field("push", "pushed"));
    outcome.metric(
        "sync.failed",
        "Sync: pushes failed",
        field("push", "failed"),
    );
    outcome.raw("bench", json!(bench));
    outcome.raw("url", target.url.clone());
    outcome.raw("source", json!(settings.sync_source));
    outcome.raw("runs", Value::Object(runs));
    outcome.raw(
        "note",
        json!("pushed into the target as found, not a recreated database"),
    );
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_macs_pane_view_is_accepted() {
        for url in [
            "http://127.0.0.1:3100",
            "http://127.0.0.1:3100/",
            "http://localhost:3100/api",
            "https://LOCALHOST",
            "http://127.0.0.1",
        ] {
            assert!(check_local(url).is_ok(), "{url} should be accepted");
        }
    }

    #[test]
    fn every_other_url_is_refused() {
        for url in [
            "https://pane-view.up.railway.app",
            "http://127.0.0.1.example.com:3100",
            "http://localhost.example.com",
            "http://127.0.0.1@example.com",
            "http://user:pass@127.0.0.1:3100",
            "http://example.com/?to=127.0.0.1",
            "http://example.com#127.0.0.1",
            "http://127.0.0.2:3100",
            "http://[::1]:3100",
            "http://0.0.0.0:3100",
            "http://127.0.0.1:",
            "http://127.0.0.1:99999",
            "127.0.0.1:3100",
            "ftp://127.0.0.1",
            " http://127.0.0.1:3100",
            "",
        ] {
            assert!(check_local(url).is_err(), "{url} should be refused");
        }
    }
}
