//! The Markdown table the runs reduce to: one line per measure, grouped by row, with each app's
//! median and spread over the rounds and how each app after the first differs from it.

use serde_json::{Value, json};

use super::stats::{Summary, change};
use super::{Record, Row};

/// One measure across apps: each app's values, round by round.
pub struct Line {
    pub row: Row,
    pub key: String,
    pub label: String,
    /// Per app, the value of each round it ran; NaN where a round measured nothing.
    pub values: Vec<Vec<f64>>,
}

impl Line {
    pub fn json(&self) -> Value {
        json!({
            "row": self.row.name(),
            "key": self.key,
            "label": self.label,
            "values": self.values,
            "median": self
                .values
                .iter()
                .map(|values| Summary::of(values).map(|summary| summary.median))
                .collect::<Vec<_>>(),
        })
    }
}

/// The measures in the rows' order, then in the order the runs gave them.
pub fn lines(apps: usize, rows: &[Row], records: &[Record]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    for row in rows {
        let start = lines.len();
        for record in records.iter().filter(|record| record.row == *row) {
            for metric in &record.metrics {
                let index = match lines[start..]
                    .iter()
                    .position(|line| line.key == metric.key)
                {
                    Some(found) => start + found,
                    None => {
                        lines.push(Line {
                            row: *row,
                            key: metric.key.clone(),
                            label: metric.label.clone(),
                            values: vec![Vec::new(); apps],
                        });
                        lines.len() - 1
                    }
                };
                if let Some(values) = lines[index].values.get_mut(record.app) {
                    values.push(metric.value);
                }
            }
        }
    }
    lines
}

/// The table, with a legend naming the apps above it.
pub fn markdown(apps: &[String], lines: &[Line], rounds: usize, legend: &[String]) -> String {
    let mut out = format!(
        "Oriel RS measure: {rounds} round(s), median (min–max) of each.\n\n{}\n\n",
        legend
            .iter()
            .map(|line| format!("- {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let mut header = vec!["Measure".to_owned()];
    header.extend(apps.iter().cloned());
    header.extend(
        apps.iter()
            .skip(1)
            .map(|app| format!("{app} vs {}", apps[0])),
    );
    out.push_str(&format!("| {} |\n", header.join(" | ")));
    let mut rule = vec!["---".to_owned()];
    rule.extend(std::iter::repeat_n("---:".to_owned(), header.len() - 1));
    out.push_str(&format!("|{}|\n", rule.join("|")));
    for line in lines {
        let summaries: Vec<Option<Summary>> = line
            .values
            .iter()
            .map(|values| Summary::of(values))
            .collect();
        let mut cells = vec![line.label.clone()];
        cells.extend(
            summaries.iter().map(|summary| {
                summary.map_or_else(|| "–".to_owned(), |summary| summary.cell(rounds))
            }),
        );
        cells.extend(
            summaries
                .iter()
                .skip(1)
                .map(|summary| match (summaries[0], summary) {
                    (Some(base), Some(other)) => change(base.median, other.median),
                    _ => String::new(),
                }),
        );
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::Metric;
    use super::*;

    fn record(row: Row, app: usize, values: &[(&str, f64)]) -> Record {
        Record {
            row,
            app,
            metrics: values
                .iter()
                .map(|(key, value)| Metric {
                    key: (*key).to_owned(),
                    label: format!("{key} (ms)"),
                    value: *value,
                })
                .collect(),
        }
    }

    #[test]
    fn a_two_app_table_shows_medians_spreads_and_the_change() {
        let records = [
            record(Row::ColdStart, 0, &[("first", 383.)]),
            record(Row::ColdStart, 1, &[("first", 350.)]),
            record(Row::ColdStart, 1, &[("first", 340.)]),
            record(Row::ColdStart, 0, &[("first", 474.)]),
            record(Row::ColdStart, 0, &[("first", 370.)]),
            record(Row::ColdStart, 1, &[("first", f64::NAN)]),
        ];
        let apps = ["A".to_owned(), "B".to_owned()];
        let lines = lines(2, &[Row::ColdStart], &records);
        let table = markdown(&apps, &lines, 3, &[]);
        let body: Vec<&str> = table
            .lines()
            .skip_while(|line| !line.starts_with('|'))
            .collect();
        assert_eq!(
            body,
            [
                "| Measure | A | B | B vs A |",
                "|---|---:|---:|---:|",
                "| first (ms) | 383 (370–474) | 345 (340–350) n=2 | −9.92 % |",
            ]
        );
    }
}
