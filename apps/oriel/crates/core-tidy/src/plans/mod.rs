//! Changing the archive, from glazier-core's `plans/`: the [`planner`] turns a request into steps,
//! the [`executor`] applies and undoes them, [`holding`] keeps what a change takes out of a root,
//! the [`journal`] is the history, and [`wording`] names it all.

pub mod encode_budget;
pub mod executor;
pub mod holding;
pub mod journal;
pub mod planner;
pub mod wording;
