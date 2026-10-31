//! The doctor, from `doctor.ts`: "Check connection" on a profile. It checks the source folder,
//! that a URL and a token are there, and that the snapshot endpoint answers with them.

use std::path::Path;

use oriel_runtime::CancelToken;
use serde::{Deserialize, Serialize};

use crate::api::{ApiTarget, PaneViewClient};
use crate::events::{Observer, RunAction, RunEvent, RunStatus, RunSummary, emit, status};
use crate::format::node_error_message;

/// `DoctorOptions`: whatever the profile has.
#[derive(Clone, Debug, Default)]
pub struct DoctorOptions {
    pub source_root: Option<String>,
    pub api_url: Option<String>,
    pub api_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorCheck {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub label: String,
    pub ok: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorResult {
    pub checks: Vec<DoctorCheck>,
    pub ok: bool,
}

fn check(label: &str, ok: bool, detail: Option<String>) -> DoctorCheck {
    DoctorCheck {
        detail,
        label: label.to_owned(),
        ok,
    }
}

/// `doctor`. Run it on the tokio thread; the snapshot check is the only one that waits.
pub async fn doctor(
    options: DoctorOptions,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> DoctorResult {
    let mut checks = Vec::new();

    if let Some(source_root) = options
        .source_root
        .as_deref()
        .filter(|root| !root.is_empty())
    {
        checks.push(match std::fs::metadata(Path::new(source_root)) {
            Ok(metadata) => check(
                "Source path",
                metadata.is_dir(),
                Some(source_root.to_owned()),
            ),
            Err(error) => check(
                "Source path",
                false,
                Some(format!(
                    "{source_root} ({})",
                    node_error_message(&error, "stat", source_root)
                )),
            ),
        });
    }

    let api_url = options.api_url.filter(|url| !url.is_empty());
    let api_token = options.api_token.filter(|token| !token.is_empty());
    checks.push(check("API URL", api_url.is_some(), api_url.clone()));
    checks.push(check("API token", api_token.is_some(), None));

    if let (Some(url), Some(token)) = (api_url, api_token) {
        status(observer, "Checking API snapshot endpoint...");
        let snapshot = match PaneViewClient::new(ApiTarget { url, token }) {
            Ok(client) => client.fetch_snapshot(Some(cancel)).await,
            Err(error) => Err(error),
        };
        checks.push(match snapshot {
            Ok(entries) => check(
                "API snapshot",
                true,
                Some(format!("{} remote entries", entries.len())),
            ),
            Err(error) => check("API snapshot", false, Some(error.to_string())),
        });
    }

    let ok = checks.iter().all(|check| check.ok);
    let mut summary = RunSummary::now(
        RunAction::Doctor,
        if ok {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        },
    );
    summary.failed = usize::from(!ok);
    summary.message = Some(
        if ok {
            "All checks passed."
        } else {
            "Some checks failed."
        }
        .to_owned(),
    );
    emit(observer, RunEvent::Complete(summary));
    DoctorResult { checks, ok }
}
