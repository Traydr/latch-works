import type { AudioState, FileId, RootId } from "@latch-works/glazier-core/contract";
import { useState } from "react";

import { usePlanner } from "../components/PlanDialog";
import { EmptyState, ProgressBar, StatTile, ViewHeader } from "../components/ui";
import { call } from "../lib/api";
import { useActiveJob, useEngine, useEngineQuery } from "../lib/engine-state";
import { formatCount } from "../lib/format";
import { useNavigation } from "../lib/navigation";

const STRIP_LIMIT = 5000;

/** Collects the ids of every video in a root with the given audio state, up to a limit. */
async function collectVideoIds(rootId: RootId, audioState: AudioState): Promise<FileId[]> {
  const ids: FileId[] = [];

  for (let offset = 0; offset < STRIP_LIMIT; offset += 1000) {
    const page = await call("listFiles", {
      rootId,
      search: "",
      kinds: ["video"],
      formats: [],
      audioStates: [audioState],
      flags: [],
      dir: null,
      sort: "path",
      descending: false,
      offset,
      limit: 1000,
    });

    ids.push(...page.rows.map((row) => row.id));

    if (page.rows.length < 1000) {
      break;
    }
  }

  return ids;
}

export function SoundView({ rootId }: { rootId: RootId }) {
  const overview = useEngineQuery("overview", { rootId });
  const job = useActiveJob("sound", rootId);
  const { report } = useEngine();
  const { openLibrary } = useNavigation();
  const { propose } = usePlanner();
  const [collecting, setCollecting] = useState(false);
  const sound = overview.data?.sound;

  if (!sound) {
    return <EmptyState title={overview.error ?? "Reading the catalog…"} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Sound"
        description="Whether each video can be heard: no audio track, a silent track, or real sound."
      >
        <button
          type="button"
          className="ls-btn ls-btn-primary"
          disabled={job !== null || sound.unmeasured === 0}
          onClick={() => void call("analyzeSound", { rootId }).catch(report)}
        >
          {job ? "Listening…" : "Measure sound"}
        </button>
      </ViewHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {job ? <ProgressBar ratio={job.total > 0 ? job.done / job.total : null} /> : null}

        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ["none", "No audio track", sound.none],
              ["silent", "Silent track", sound.silent],
              ["sound", "Has sound", sound.sound],
              ["unmeasured", "Not measured yet", sound.unmeasured],
            ] as const
          ).map(([state, label, count]) => (
            <button
              key={state}
              type="button"
              className="text-left"
              onClick={() => openLibrary({ kinds: ["video"], audioStates: [state] })}
            >
              <StatTile label={label} value={formatCount(count)} detail="Show in Library" />
            </button>
          ))}
        </div>

        <p className="text-xs text-zinc-500">
          A track counts as silent when its loudest moment stays below −60 dBFS. Measuring decodes
          each soundtrack once (fast, but it reads every video with audio), so it runs only when you
          ask.
        </p>

        {sound.silent > 0 ? (
          <section className="ls-surface-2 space-y-1.5 p-3 text-xs">
            <h2 className="ls-label">Silent tracks</h2>
            <p className="text-zinc-500">
              Removing a silent track copies the picture into MP4 untouched; only the empty audio
              goes.
            </p>
            <button
              type="button"
              className="ls-btn"
              disabled={collecting}
              onClick={async () => {
                setCollecting(true);

                try {
                  const fileIds = await collectVideoIds(rootId, "silent");

                  if (fileIds.length > 0) {
                    propose(`Strip ${formatCount(fileIds.length)} silent tracks`, {
                      kind: "strip-audio",
                      fileIds,
                    });
                  }
                } catch (error) {
                  report(error);
                } finally {
                  setCollecting(false);
                }
              }}
            >
              Strip silent tracks
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
