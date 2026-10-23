import type {
  OptimizeCategory,
  OptimizeEstimate,
  RootId,
} from "@latch-works/glazier-core/contract";
import { useState } from "react";

import { usePlanner } from "../components/PlanDialog";
import { EmptyState, ViewHeader } from "../components/ui";
import { call } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount } from "../lib/format";
import { useNavigation } from "../lib/navigation";

const CATEGORIES = {
  "still-to-avif": {
    label: "Stills → AVIF",
    detail:
      "PNG, JPEG, WebP and BMP at quality 70, speed 6 (speed 8 when memory runs out; sharp above 64 MP).",
    transcoder: false,
  },
  "animation-to-mp4": {
    label: "Animations → MP4",
    detail: "Animated GIF, WebP and PNG, frame by frame, as H.264.",
    transcoder: true,
  },
  "video-remux": {
    label: "Videos → MP4, lossless",
    detail: "MOV, MKV and WebM whose tracks MP4 can carry as they are. Nothing is re-encoded.",
    transcoder: true,
  },
  "video-convert": {
    label: "Videos → MP4, re-encoded",
    detail: "Tracks in codecs MP4 players can't use become H.264 and AAC.",
    transcoder: true,
  },
  "rename-avif": {
    label: "Rename to .avif",
    detail: "AVIF bytes saved under another extension.",
    transcoder: false,
  },
  "rename-mp4": {
    label: "Rename to .mp4",
    detail: "MP4 bytes under another extension, such as .m4v.",
    transcoder: false,
  },
} as const satisfies Record<
  OptimizeCategory,
  { label: string; detail: string; transcoder: boolean }
>;

const CONVERSIONS = new Set<OptimizeCategory>([
  "still-to-avif",
  "animation-to-mp4",
  "video-remux",
  "video-convert",
]);

export function OptimizeView({ rootId }: { rootId: RootId }) {
  const summary = useEngineQuery("optimizeSummary", { rootId });
  const { capabilities, report } = useEngine();
  const { propose } = usePlanner();
  const { openLibrary } = useNavigation();
  const [chosen, setChosen] = useState<Set<OptimizeCategory>>(new Set(["still-to-avif"]));

  const [estimates, setEstimates] = useState<Map<OptimizeCategory, OptimizeEstimate | "running">>(
    new Map(),
  );

  const estimate = async (category: OptimizeCategory) => {
    setEstimates((current) => new Map(current).set(category, "running"));

    try {
      const result = await call("estimateOptimize", { rootId, category });
      setEstimates((current) => new Map(current).set(category, result));
    } catch (error) {
      setEstimates((current) => {
        const next = new Map(current);
        next.delete(category);

        return next;
      });
      report(error);
    }
  };

  const data = summary.data;

  if (!data) {
    return <EmptyState title={summary.error ?? "Checking files against the archive formats…"} />;
  }

  const rows = data.categories.filter((category) => category.files > 0);
  const avcMissing = capabilities !== null && !capabilities.video.avc;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Optimize"
        description="Files that are not yet in the archive formats: AVIF for stills, MP4 for everything that moves."
      >
        <button
          type="button"
          className="ls-btn ls-btn-cta"
          disabled={chosen.size === 0 || rows.length === 0}
          onClick={() =>
            propose("Convert to the archive formats", {
              kind: "optimize",
              rootId,
              categories: [...chosen],
              fileIds: null,
            })
          }
        >
          Review conversions
        </button>
      </ViewHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {avcMissing ? (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            This machine's WebCodecs reports no H.264 encoder, so animation and video conversions
            will fail.
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Everything in this root is already in the archive formats.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] tracking-wide text-zinc-500 uppercase">
                <th className="w-8 py-1.5" />
                <th className="py-1.5">Conversion</th>
                <th className="py-1.5 text-right">Files</th>
                <th className="py-1.5 text-right">Now</th>
                <th className="py-1.5 text-right">Estimated after</th>
                <th className="w-28 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map((row) => {
                const info = CATEGORIES[row.category];
                const result = estimates.get(row.category);

                return (
                  <tr key={row.category} data-category={row.category}>
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={info.label}
                        checked={chosen.has(row.category)}
                        onChange={(event) => {
                          const next = new Set(chosen);

                          if (event.target.checked) {
                            next.add(row.category);
                          } else {
                            next.delete(row.category);
                          }

                          setChosen(next);
                        }}
                      />
                    </td>
                    <td className="py-2">
                      <div className="font-medium">{info.label}</div>
                      <div className="text-zinc-500">{info.detail}</div>
                    </td>
                    <td className="tabular py-2 text-right">{formatCount(row.files)}</td>
                    <td className="tabular py-2 text-right">{formatBytes(row.bytes)}</td>
                    <td className="tabular py-2 text-right">
                      {result === undefined ? (
                        <span className="text-zinc-400">—</span>
                      ) : result === "running" ? (
                        <span className="text-zinc-500">Sampling…</span>
                      ) : result.sampled === 0 ? (
                        <span className="text-zinc-500">No sample converted</span>
                      ) : (
                        <span title={`From ${result.sampled} sampled files`}>
                          {formatBytes(row.bytes * result.ratioLow)}–
                          {formatBytes(row.bytes * result.ratioHigh)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {CONVERSIONS.has(row.category) ? (
                        <button
                          type="button"
                          className="ls-btn ls-btn-ghost py-0.5"
                          disabled={result === "running"}
                          onClick={() => void estimate(row.category)}
                        >
                          Estimate
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {data.skipped.length > 0 ? (
          <section>
            <h2 className="ls-label mb-1.5">Left as they are</h2>
            <ul className="space-y-0.5 text-xs text-zinc-500">
              {data.skipped.map((entry) => (
                <li key={entry.reason}>
                  <span className="tabular font-medium text-zinc-700 dark:text-zinc-300">
                    {formatCount(entry.files)}
                  </span>{" "}
                  {entry.reason}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="ls-surface-2 space-y-1.5 p-3 text-xs">
          <h2 className="ls-label">Re-encode to save space</h2>
          <p className="text-zinc-500">
            HEVC and AV1 store the same video in fewer bytes, but not every device plays them (older
            ones lack AV1). Pick the videos in the Library and choose Re-encode…; each result must
            be at least 5% smaller or the original stays.
          </p>
          <button
            type="button"
            className="ls-btn"
            onClick={() => openLibrary({ kinds: ["video"] })}
          >
            Choose videos
          </button>
        </section>

        <p className="text-[11px] text-zinc-500">
          Each converted file keeps its original's modification date; the original moves to the
          holding folder and the journal can undo it.
        </p>
      </div>
    </div>
  );
}
