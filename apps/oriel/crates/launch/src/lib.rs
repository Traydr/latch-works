//! What a launch is told, read once at start: where the data lives, what to open, and its
//! `ORIEL_*` variables ([`Launch`]). The shell and every mode are built from it, and each parses
//! the check and spike variables it owns, named in its own crate.
//!
//! [`variables`] and [`storage_keys`] name only what xtask's `measure` must agree on with the app:
//! the variables it sets and the stored preferences it seeds. They live here rather than in
//! `oriel-core-paths`, so a new measurement knob rebuilds the modes, the shell and xtask, and not
//! the libraries under them.
//!
//! The native-library overrides (`ORIEL_LIBVIPS`, `ORIEL_LIBAVIF`, `ORIEL_LIBMPV`,
//! `ORIEL_MEDIA_TOOLS`) are not launch settings: tests, examples and xtask use them with no
//! launch, so `oriel_core_paths::NativeSet` reads them where it searches. So does `core-sync` with
//! its tests' `ORIEL_SYNC_STACK_*`.

use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::str::FromStr;

use oriel_core_paths::DataRoot;

/// Every variable the app reads starts with this.
pub const PREFIX: &str = "ORIEL_";

/// The variables xtask's `measure` sets, which the app reads.
pub mod variables {
    /// Replaces the data root with a sandboxed one, for checks, tests and measurements.
    pub const DATA_DIR: &str = "ORIEL_DATA_DIR";
    /// View opens this folder at start.
    pub const OPEN: &str = "ORIEL_OPEN";
    /// Tidy opens on this root, adding it first if it is not one.
    pub const TIDY_ROOT: &str = "ORIEL_TIDY_ROOT";
    /// Tidy opens on this page, by its stored name; `duplicates:identical` and
    /// `duplicates:variants` pick Duplicates' tab.
    pub const TIDY_PAGE: &str = "ORIEL_TIDY_PAGE";
    /// The measurements' JSON-lines log, for View's and the Library's spikes.
    pub const SPIKE_LOG: &str = "ORIEL_SPIKE_LOG";
    /// How long a spike rests at the end, in milliseconds.
    pub const SPIKE_REST_MS: &str = "ORIEL_SPIKE_REST_MS";
    /// A spike quits once it is done.
    pub const SPIKE_QUIT: &str = "ORIEL_SPIKE_QUIT";
    /// The window's size for View's spike: `1280x900`.
    pub const SPIKE_WINDOW: &str = "ORIEL_SPIKE_WINDOW";
    /// View's spike waits for every thumbnail.
    pub const SPIKE_FILL: &str = "ORIEL_SPIKE_FILL";
    /// How fast a spike scrolls, in points a second.
    pub const SPIKE_SCROLL: &str = "ORIEL_SPIKE_SCROLL";
    /// How many steps View's spike takes through the viewer.
    pub const SPIKE_STEPS: &str = "ORIEL_SPIKE_STEPS";
    /// The Library's spike, with that many synthetic rows.
    pub const SPIKE_LIBRARY: &str = "ORIEL_SPIKE_LIBRARY";
}

/// The keys of `local-storage.json` xtask's `measure` seeds, which the app reads.
pub mod storage_keys {
    /// The mode shown last: `view`, `tidy` or `sync`.
    pub const MODE: &str = "oriel.mode";
    /// Tidy's page shown last, by its stored name.
    pub const TIDY_VIEW: &str = "oriel.tidy.view";
}

/// What a launch was told: the shell and each mode are made from it.
pub struct Launch {
    pub data: DataRoot,
    /// A folder or file for View to show: the one the system hands the app at launch, else the one
    /// `ORIEL_OPEN` names.
    pub open: Option<PathBuf>,
    pub variables: Variables,
}

impl Launch {
    /// This process's launch, `open` being the path its command line hands it.
    pub fn from_environment(open: Option<PathBuf>) -> io::Result<Self> {
        Self::from_variables(Variables::from_environment(), open)
    }

    /// The launch `variables` describe: [`variables::DATA_DIR`] when set chooses a sandboxed data
    /// root, else the owner's.
    pub fn from_variables(variables: Variables, open: Option<PathBuf>) -> io::Result<Self> {
        let data = match variables.get(variables::DATA_DIR) {
            Some(chosen) => DataRoot::at(PathBuf::from(chosen))?,
            None => DataRoot::of_owner()?,
        };
        Ok(Self {
            data,
            open: open.or_else(|| variables.get(variables::OPEN).map(PathBuf::from)),
            variables,
        })
    }

    /// A launch over `data` that asks for nothing, as the tests start.
    pub fn of(data: DataRoot) -> Self {
        Self {
            data,
            open: None,
            variables: Variables::default(),
        }
    }
}

/// The `ORIEL_*` variables a launch was given, read once. A variable set to nothing counts as
/// not set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Variables(BTreeMap<String, String>);

impl Variables {
    /// This process's `ORIEL_*` variables. One that is not Unicode is left out.
    pub fn from_environment() -> Self {
        Self::from_pairs(std::env::vars_os().filter_map(|(name, value)| {
            Some((name.into_string().ok()?, value.into_string().ok()?))
        }))
    }

    /// The `ORIEL_*` variables among `pairs`, as a test or a check gives them.
    pub fn from_pairs<K: Into<String>, V: Into<String>>(
        pairs: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        Self(
            pairs
                .into_iter()
                .map(|(name, value)| (name.into(), value.into()))
                .filter(|(name, value)| name.starts_with(PREFIX) && !value.is_empty())
                .collect(),
        )
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    /// Whether `name` is set to anything.
    pub fn is_set(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    /// Whether `name` is `1`.
    pub fn is_on(&self, name: &str) -> bool {
        self.get(name) == Some("1")
    }

    /// `name` read as a `T`, if it is set and reads as one.
    pub fn parse<T: FromStr>(&self, name: &str) -> Option<T> {
        self.get(name)?.parse().ok()
    }

    /// Every variable, by name.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}
