import type { FindingKind, RootId } from "@latch-works/glazier-core/contract";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";

import { usePlanner } from "../components/PlanDialog";
import { EmptyState, Panel, StatTile, ViewHeader } from "../components/ui";
import { call } from "../lib/api";
import { useActiveJob, useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatLabel } from "../lib/format";
import { type LibraryPreset, useNavigation } from "../lib/navigation";

type Severity = "warning" | "serious" | "info";

interface FindingInfo {
  label: string;
  severity: Severity;
  preset: Partial<LibraryPreset> | null;
}

const FINDINGS = {
  "extension-mismatch": {
    label: "extensions that don't match the bytes",
    severity: "warning",
    preset: { flags: ["extension-mismatch"] },
  },
  undecodable: {
    label: "files that won't decode",
    severity: "serious",
    preset: { flags: ["undecodable"] },
  },
  "zero-byte": { label: "zero-byte files", severity: "serious", preset: { flags: ["zero-byte"] } },
  junk: {
    label: "system junk files (.DS_Store, ._*)",
    severity: "info",
    preset: { flags: ["junk"] },
  },
  "empty-folder": { label: "empty folders", severity: "info", preset: null },
  unsupported: {
    label: "files no Latch Works app shows",
    severity: "info",
    preset: { flags: ["unsupported"] },
  },
  "presigned-delivery": {
    label: "MKV and BMP originals Pane serves by presigned URL, not Shutter",
    severity: "info",
    preset: { formats: ["matroska", "bmp"] },
  },
  "unconvertible-video": {
    label: "AVI, FLV and WMV videos that can't be moved into MP4",
    severity: "warning",
    preset: { formats: ["avi", "flv", "asf"] },
  },
} as const satisfies Record<FindingKind, FindingInfo>;

function SeverityIcon({ severity }: { severity: Severity }) {
  switch (severity) {
    case "warning":
      return <AlertTriangle aria-label="Warning" className="size-3.5 shrink-0 text-amber-500" />;
    case "serious":
      return <CircleAlert aria-label="Serious" className="size-3.5 shrink-0 text-orange-500" />;
    case "info":
      return <Info aria-label="Info" className="size-3.5 shrink-0 text-zinc-400" />;
    default: {
      const _exhaustive: never = severity;

      return _exhaustive;
    }
  }
}

export function OverviewView({ rootId }: { rootId: RootId }) {
  const overview = useEngineQuery("overview", { rootId });
  const { openLibrary, go } = useNavigation();
  const { propose } = usePlanner();
  const { report } = useEngine();
  const scan = useActiveJob("scan", rootId);
  const data = overview.data;

  if (!data) {
    return <EmptyState title={overview.error ?? "Reading the catalog…"} />;
  }

  if (data.files === 0) {
    return (
      <EmptyState title={scan ? "Scanning this root…" : "No files yet"}>
        {scan ? "The overview fills in as the scan finds files." : "Rescan the root to catalog it."}
      </EmptyState>
    );
  }

  const formats = data.byFormat.slice(0, 10);
  const largest = Math.max(1, ...formats.map((entry) => entry.bytes));
  const findings = data.findings.filter((finding) => finding.count > 0);
  const soundless = data.sound.none + data.sound.silent;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Overview"
        description="What this root holds, and what Glazier would change about it."
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        <div className="grid grid-cols-4 gap-3">
          <StatTile
            label="Files"
            value={formatCount(data.files)}
            detail={`${formatBytes(data.bytes)} in ${formatCount(data.folders)} folders`}
          />
          <StatTile
            label="Duplicate groups"
            value={formatCount(data.duplicates.groups)}
            detail={`${formatBytes(data.duplicates.reclaimableBytes)} reclaimable`}
          />
          <StatTile
            label="Optimizable"
            value={formatCount(data.optimizable.files)}
            detail={`${formatBytes(data.optimizable.bytes)} in other formats`}
          />
          <StatTile
            label="Videos without sound"
            value={formatCount(soundless)}
            detail={
              data.sound.unmeasured > 0
                ? `${formatCount(data.sound.none)} no track · ${formatCount(data.sound.unmeasured)} not measured`
                : `${formatCount(data.sound.none)} no track · ${formatCount(data.sound.silent)} silent`
            }
          />
        </div>

        <div className="grid grid-cols-[1.1fr_1fr] gap-3">
          <Panel title="Size by format">
            <ul className="space-y-0.5" aria-label="Size by format">
              {formats.map((entry) => (
                <li key={`${entry.format}-${entry.kind}`}>
                  <button
                    type="button"
                    title={`${formatLabel(entry.format)} · ${formatBytes(entry.bytes)} · ${formatCount(entry.files)} files`}
                    onClick={() =>
                      openLibrary(
                        entry.format === null
                          ? { kinds: [entry.kind] }
                          : { formats: [entry.format] },
                      )
                    }
                    className="grid w-full grid-cols-[72px_minmax(0,1fr)_64px] items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                  >
                    <span className="truncate text-zinc-600 dark:text-zinc-300">
                      {formatLabel(entry.format)}
                    </span>
                    <span className="flex h-2.5 items-center">
                      <span
                        className="h-2.5 min-w-[2px] rounded-r bg-sky-600 dark:bg-sky-500"
                        style={{ width: `${(entry.bytes / largest) * 100}%` }}
                      />
                    </span>
                    <span className="tabular text-right">{formatBytes(entry.bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Findings">
            {findings.length === 0 ? (
              <p className="text-xs text-zinc-500">Nothing to report.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {findings.map((finding) => {
                  const info: FindingInfo = FINDINGS[finding.kind];

                  return (
                    <li
                      key={finding.kind}
                      className="flex items-start gap-2 py-1.5 text-xs"
                      data-finding={finding.kind}
                    >
                      <SeverityIcon severity={info.severity} />
                      <span className="min-w-0 flex-1">
                        <span className="tabular font-medium">{formatCount(finding.count)}</span>{" "}
                        {info.label}
                      </span>
                      {finding.kind === "junk" ? (
                        <button
                          type="button"
                          className="ls-btn ls-btn-ghost py-0.5"
                          onClick={() =>
                            propose("Move system junk to holding", { kind: "clean-junk", rootId })
                          }
                        >
                          Clean
                        </button>
                      ) : null}
                      {finding.kind === "empty-folder" ? (
                        <button
                          type="button"
                          className="ls-btn ls-btn-ghost py-0.5"
                          onClick={() =>
                            propose("Remove empty folders", {
                              kind: "remove-empty-folders",
                              rootId,
                            })
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                      {info.preset ? (
                        <button
                          type="button"
                          className="ls-btn ls-btn-ghost py-0.5"
                          onClick={() => info.preset && openLibrary(info.preset)}
                        >
                          Show
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="ls-btn" onClick={() => go("duplicates")}>
            Review duplicates
          </button>
          <button type="button" className="ls-btn" onClick={() => go("optimize")}>
            Plan conversions
          </button>
          <button
            type="button"
            className="ls-btn"
            onClick={() => void call("analyzeSound", { rootId }).then(() => go("sound"), report)}
          >
            Measure sound
          </button>
        </div>
      </div>
    </div>
  );
}
