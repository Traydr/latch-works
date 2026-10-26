import { type RootId, type ShrinkSummary, shrinkBatch } from "@latch-works/glazier-core/contract";
import { ChevronRight, Shrink } from "lucide-react";
import { useState } from "react";
import { EmptyState, Kbd, Segmented, TopBar } from "../../../../ui/ui";
import { MediaTile } from "../components/tidy/MediaTile";
import { RunProgress } from "../components/tidy/RunProgress";
import { useActions } from "../lib/actions";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatSpan, plural } from "../lib/format";
import { isCommandKey, useViewKeys } from "../lib/hotkeys";

const SOURCE = "shrink";

/** How much a run takes, by the bytes of its originals; "all" takes every video. */
const BATCHES = [
  { value: "5", label: "5 GB", limitBytes: 5e9 },
  { value: "20", label: "20 GB", limitBytes: 20e9 },
  { value: "all", label: "All", limitBytes: null },
] as const;

type BatchChoice = (typeof BATCHES)[number]["value"];

const BATCH_KEY = "oriel.tidy.shrink.batch";

function storedBatch(): BatchChoice {
  const stored = window.localStorage.getItem(BATCH_KEY);

  return BATCHES.find((batch) => batch.value === stored)?.value ?? "5";
}

/** Why the engine left videos out of Shrink, said the way the owner would say it. */
const SKIP_WORDS = new Map<string, readonly [string, string]>([
  ["Already AV1", ["is already AV1", "are already AV1"]],
  [
    "Already compact",
    [
      "is already compact, so AV1 would save little",
      "are already compact, so AV1 would save little",
    ],
  ],
  ["Came out no smaller as AV1", ["came out no smaller as AV1", "came out no smaller as AV1"]],
  [
    "Identical copies (resolve duplicates first)",
    [
      "is an identical copy and waits for duplicate review",
      "are identical copies and wait for duplicate review",
    ],
  ],
  [
    "Similar versions (review them first)",
    ["is in a similar set and waits for review", "are in similar sets and wait for review"],
  ],
  [
    "Not checked for similar versions yet",
    ["is still being checked for similar versions", "are still being checked for similar versions"],
  ],
  ["Won't decode", ["won't open", "won't open"]],
  [
    "A file with the target name already exists",
    ["would take a name already in use", "would take a name already in use"],
  ],
]);

function leftReasons(summary: ShrinkSummary): string[] {
  return summary.skipped.flatMap((entry) => {
    if (entry.files === 0) {
      return [];
    }

    const words = SKIP_WORDS.get(entry.reason);

    return words
      ? [`${plural(entry.files, "video")} ${entry.files === 1 ? words[0] : words[1]}`]
      : [`${plural(entry.files, "video")}: ${entry.reason}`];
  });
}

/**
 * Re-encodes videos to AV1 in batches, the most bytes saved first. A run can be paused or
 * stopped at any time: finished videos stay done, and the next run starts with what is left.
 */
export function ShrinkView({ rootId }: { rootId: RootId }) {
  const query = useEngineQuery("shrinkSummary", { rootId });
  const { capabilities } = useEngine();
  const actions = useActions();
  const [batchChoice, setBatchChoice] = useState<BatchChoice>(storedBatch);
  const [leftOpen, setLeftOpen] = useState(false);
  const job = actions.jobFor(SOURCE);
  const summary = query.data;
  const limitBytes = BATCHES.find((batch) => batch.value === batchChoice)?.limitBytes ?? null;
  const batch = summary ? shrinkBatch(summary.items, limitBytes) : [];

  const totals = (items: typeof batch) =>
    items.reduce(
      (sum, item) => ({
        bytes: sum.bytes + item.bytes,
        estimated: sum.estimated + item.estimatedBytes,
        encodeMs: sum.encodeMs + item.encodeMs,
      }),
      { bytes: 0, estimated: 0, encodeMs: 0 },
    );

  const next = totals(batch);
  const all = totals(summary?.items ?? []);

  const chooseBatch = (choice: BatchChoice) => {
    setBatchChoice(choice);
    window.localStorage.setItem(BATCH_KEY, choice);
  };

  const shrink = () =>
    void actions.perform({ kind: "shrink-videos", rootId, limitBytes }, { source: SOURCE });

  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Enter" && batch.length > 0 && job === null) {
      shrink();

      return true;
    }

    return false;
  });

  if (!summary) {
    return (
      <>
        <TopBar title="Shrink" />
        {query.error ? <EmptyState title={query.error} /> : <div className="flex-1" />}
      </>
    );
  }

  const reasons = leftReasons(summary);
  const left = summary.skipped.reduce((sum, entry) => sum + entry.files, 0);
  const inBatch = new Set(batch.map((item) => item.fileId));
  const tiles = summary.preview.filter((row) => inBatch.has(row.id));
  const estimates = new Map(summary.items.map((item) => [item.fileId, item]));
  const more = batch.length - tiles.length;

  return (
    <>
      <TopBar
        title="Shrink"
        meta={
          summary.items.length > 0 ? (
            <>
              {plural(summary.items.length, "video")} · {formatBytes(all.bytes)} → about{" "}
              {formatBytes(all.estimated)}
            </>
          ) : null
        }
      >
        {summary.items.length > 0 ? (
          <Segmented
            label="How much each run takes"
            options={BATCHES.map((choice) => ({ value: choice.value, label: choice.label }))}
            value={batchChoice}
            onChange={chooseBatch}
          />
        ) : null}
        {job ? (
          <RunProgress job={job} />
        ) : (
          <button
            type="button"
            className="lw-btn lw-btn-primary lw-btn-lg"
            disabled={batch.length === 0}
            onClick={shrink}
          >
            Shrink {formatCount(batch.length)} <Kbd>⌘↩</Kbd>
          </button>
        )}
      </TopBar>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-28">
        {summary.items.length === 0 ? (
          <EmptyState icon={Shrink} title="Nothing left to shrink" />
        ) : (
          <section className="lw-card mb-5 p-5" data-section="next">
            <p className="text-xs font-medium text-zinc-500">
              {batchChoice === "all" ? "Every video" : "Next run"}
            </p>
            <p className="lw-display mt-1">
              {formatBytes(next.bytes)} → about {formatBytes(next.estimated)}
            </p>
            <p className="lw-caption mt-1.5 leading-5">
              {plural(batch.length, "video")}, the most space saved first · roughly{" "}
              {formatSpan(next.encodeMs)} of encoding
              {summary.speedMeasured
                ? " at this computer's speed"
                : ", a first guess until this computer has shrunk a few videos"}
              . Stop whenever you like: finished videos stay done, and the next run starts with what
              is left.
            </p>
            <p className="lw-caption mt-3 leading-5">
              {capabilities?.svtAv1 === false
                ? "This build's ffmpeg has no SVT-AV1, so AV1 uses the slower, larger WebCodecs encoder. "
                : "AV1 with SVT-AV1; Video quality in Settings sets how hard it squeezes (High is CRF 35). "}
              Originals wait in holding, and Undo puts them back. Safari, and every browser on
              iPhone and iPad, plays AV1 only on A17 Pro, M3 and later chips.
            </p>
          </section>
        )}

        {tiles.length > 0 ? (
          <section data-section="batch">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-3 gap-y-4 pt-1 pb-6">
              {tiles.map((row) => {
                const item = estimates.get(row.id);

                return (
                  <MediaTile
                    key={row.id}
                    row={row}
                    ratio={item && item.bytes > 0 ? item.estimatedBytes / item.bytes : null}
                  />
                );
              })}
            </div>
            {more > 0 ? (
              <p className="-mt-3 mb-6 text-[13px] text-zinc-500 dark:text-zinc-400">
                and {formatCount(more)} more in this run
              </p>
            ) : null}
          </section>
        ) : null}

        {left > 0 ? (
          <section data-section="left">
            <button
              type="button"
              aria-expanded={leftOpen}
              onClick={() => setLeftOpen((open) => !open)}
              className="lw-focus sticky top-0 z-10 flex h-9 w-full items-center gap-1.5 bg-white text-left text-[13px] font-medium dark:bg-zinc-950"
            >
              <ChevronRight
                className={`size-3.5 text-zinc-400 transition-transform duration-150 ${
                  leftOpen ? "rotate-90" : ""
                }`}
              />
              {formatCount(left)} left as they are
            </button>
            {leftOpen ? (
              <ul className="lw-card">
                {reasons.map((reason, index) => (
                  <li
                    key={reason}
                    className={`flex h-11 items-center px-4 text-[13px] ${index > 0 ? "border-t lw-divider" : ""}`}
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}
