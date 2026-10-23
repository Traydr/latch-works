import type { FileId, FileRow, RootId, SimilarityLevel } from "@latch-works/glazier-core/contract";
import { Eye, FolderOpen, Play } from "lucide-react";
import { useMemo, useState } from "react";

import { describeDetails, Thumbnail } from "../components/FileTable";
import { usePlanner } from "../components/PlanDialog";
import { EmptyState, ProgressBar, Toggle, ViewHeader } from "../components/ui";
import { call, desktop, mediaUrl, thumbnailUrl } from "../lib/api";
import { useActiveJob, useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatDate, formatLabel } from "../lib/format";

const PAGE_SIZE = 40;

type Tab = "exact" | "similar";

/** A group as the review panel shows it, from either tab. */
interface ReviewGroup {
  key: string;
  title: string;
  detail: string;
  reclaimableBytes: number;
  members: FileRow[];
  hardLinkedIds: FileId[];
}

const LEVELS = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "loose", label: "Loose" },
] as const satisfies ReadonlyArray<{ value: SimilarityLevel; label: string }>;

export function DuplicatesView({ rootId }: { rootId: RootId }) {
  const [tab, setTab] = useState<Tab>("exact");
  const [offset, setOffset] = useState(0);
  const { settings, setSettings, report } = useEngine();
  const level = settings?.similarity ?? "balanced";
  const similarJob = useActiveJob("similar", rootId);

  const exact = useEngineQuery(
    "exactDuplicates",
    tab === "exact" ? { rootId, offset, limit: PAGE_SIZE } : null,
  );

  const similar = useEngineQuery(
    "similarDuplicates",
    tab === "similar" ? { rootId, level, offset, limit: PAGE_SIZE } : null,
  );

  const groups: ReviewGroup[] = useMemo(() => {
    if (tab === "exact") {
      return (exact.data?.groups ?? []).map((group) => ({
        key: group.sha256,
        title: group.members[0]?.name ?? group.sha256.slice(0, 12),
        detail: `${group.physicalCopies} copies · ${formatBytes(group.reclaimableBytes)}`,
        reclaimableBytes: group.reclaimableBytes,
        members: group.members,
        hardLinkedIds: group.hardLinkedIds,
      }));
    }

    return (similar.data?.groups ?? []).map((group) => {
      const sizes = group.members.map((member) => member.size);

      return {
        key: `similar-${group.id}`,
        title: group.members[0]?.name ?? `Group ${group.id}`,
        detail: `${group.members.length} versions · distance ${group.distance}`,
        reclaimableBytes: sizes.reduce((sum, size) => sum + size, 0) - Math.max(0, ...sizes),
        members: group.members,
        hardLinkedIds: [],
      };
    });
  }, [tab, exact.data, similar.data]);

  const total = tab === "exact" ? (exact.data?.total ?? 0) : (similar.data?.total ?? 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Duplicates"
        description={
          tab === "exact"
            ? "Byte-identical copies, by SHA-256 (the ID Lockstep uploads under). Hard links count once."
            : "The same picture or footage encoded differently, matched by perceptual fingerprints."
        }
      >
        <Toggle
          label="Duplicate kind"
          value={tab}
          onChange={(next) => {
            setTab(next);
            setOffset(0);
          }}
          options={[
            { value: "exact", label: "Exact" },
            { value: "similar", label: "Similar" },
          ]}
        />
      </ViewHeader>

      {tab === "similar" ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b ls-divider px-5 py-2 text-xs">
          <button
            type="button"
            className="ls-btn ls-btn-primary"
            disabled={similarJob !== null}
            onClick={() => void call("analyzeSimilar", { rootId }).catch(report)}
          >
            {similarJob ? "Fingerprinting…" : "Find similar"}
          </button>
          {similar.data ? (
            <span className="text-zinc-500">
              {formatCount(similar.data.fingerprinted)} of{" "}
              {formatCount(similar.data.fingerprintable)} pictures and videos fingerprinted
            </span>
          ) : null}
          {similarJob ? (
            <div className="w-48">
              <ProgressBar
                ratio={similarJob.total > 0 ? similarJob.done / similarJob.total : null}
              />
            </div>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-zinc-500">Match</span>
            <Toggle
              label="Similarity"
              value={level}
              onChange={(next) => settings && void setSettings({ ...settings, similarity: next })}
              options={LEVELS}
            />
          </span>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <EmptyState title={tab === "exact" ? "No exact duplicates" : "No similar groups yet"}>
          {tab === "similar"
            ? "Find similar fingerprints every picture and video once (it decodes them, so it takes a while), then groups matches here."
            : "Every file with a twin of the same size is hashed during the scan."}
        </EmptyState>
      ) : (
        <GroupReview
          key={`${tab}-${offset}-${level}`}
          groups={groups}
          total={total}
          offset={offset}
          onPage={setOffset}
          tab={tab}
        />
      )}
    </div>
  );
}

function GroupReview({
  groups,
  total,
  offset,
  onPage,
  tab,
}: {
  groups: ReviewGroup[];
  total: number;
  offset: number;
  onPage: (offset: number) => void;
  tab: Tab;
}) {
  const [activeKey, setActiveKey] = useState(groups[0]?.key ?? "");
  const [keepers, setKeepers] = useState<Map<string, FileId>>(new Map());
  const { propose } = usePlanner();
  const active = groups.find((group) => group.key === activeKey) ?? groups[0];

  const keeperOf = (group: ReviewGroup): FileId | null =>
    keepers.get(group.key) ?? group.members[0]?.id ?? null;

  const resolution = (scope: readonly ReviewGroup[]) =>
    scope.flatMap((group) => {
      const keep = keeperOf(group);
      const linked = new Set(group.hardLinkedIds);
      const keepRow = group.members.find((member) => member.id === keep);

      // Removing a hard link to the kept file frees nothing and loses a path, so it stays.
      const remove = group.members.flatMap((member) =>
        member.id === keep || (keepRow && linked.has(member.id) && linked.has(keepRow.id))
          ? []
          : [member.id],
      );

      return keep !== null && remove.length > 0 ? [{ keep, remove }] : [];
    });

  const resolve = (scope: readonly ReviewGroup[], title: string) => {
    const groupsToResolve = resolution(scope);

    if (groupsToResolve.length > 0) {
      propose(title, { kind: "resolve-duplicates", groups: groupsToResolve });
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r ls-divider">
        <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Groups">
          {groups.map((group) => (
            <li key={group.key}>
              <button
                type="button"
                aria-current={group.key === active?.key}
                onClick={() => setActiveKey(group.key)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                  group.key === active?.key
                    ? "bg-zinc-200/70 dark:bg-zinc-800"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }`}
              >
                <span className="flex justify-between gap-2">
                  <span className="truncate font-medium">{group.title}</span>
                  <span className="shrink-0 text-zinc-500">×{group.members.length}</span>
                </span>
                <span className="block text-[11px] text-zinc-500">{group.detail}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t ls-divider px-3 py-2 text-[11px] text-zinc-500">
          <button
            type="button"
            className="ls-btn ls-btn-ghost py-0.5"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </button>
          <span>
            {formatCount(offset + 1)}–{formatCount(Math.min(total, offset + groups.length))} of{" "}
            {formatCount(total)}
          </span>
          <button
            type="button"
            className="ls-btn ls-btn-ghost py-0.5"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => onPage(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      </aside>

      {active ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b ls-divider px-5 py-2 text-xs">
            <span className="text-zinc-500">
              Keep by: protected folders · sound · pixels · duration · archive format · size ·
              oldest · shortest path
            </span>
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                className="ls-btn"
                onClick={() => resolve([active], `Resolve “${active.title}”`)}
              >
                Resolve this group
              </button>
              <button
                type="button"
                className="ls-btn ls-btn-primary"
                onClick={() =>
                  resolve(groups, `Resolve ${formatCount(groups.length)} ${tab} groups`)
                }
              >
                Resolve all on this page
              </button>
            </span>
          </div>
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 overflow-y-auto p-5">
            {active.members.map((member) => {
              const keep = keeperOf(active) === member.id;

              return (
                <article
                  key={member.id}
                  data-member={member.name}
                  data-keep={keep}
                  className={`ls-surface overflow-hidden ${keep ? "ring-2 ring-violet-500/70" : ""}`}
                >
                  <MemberPreview row={member} />
                  <div className="space-y-1 p-2.5 text-xs">
                    <div className="truncate font-medium" title={member.relPath}>
                      {member.relPath}
                    </div>
                    <div className="text-zinc-500">
                      {formatLabel(member.format)} · {describeDetails(member) || "—"}
                    </div>
                    <div className="tabular text-zinc-500">
                      {formatBytes(member.size)} · {formatDate(member.mtimeMs)}
                      {active.hardLinkedIds.includes(member.id) ? " · hard link" : ""}
                    </div>
                    <div className="flex items-center gap-1 pt-1">
                      <button
                        type="button"
                        className={`ls-btn py-0.5 ${keep ? "ls-btn-primary" : ""}`}
                        aria-pressed={keep}
                        onClick={() =>
                          setKeepers((current) => new Map(current).set(active.key, member.id))
                        }
                      >
                        {keep ? "Keeping" : "Keep this"}
                      </button>
                      <button
                        type="button"
                        className="ls-btn ls-btn-ghost px-1.5"
                        aria-label="Quick Look"
                        onClick={() => void desktop.quickLook(member.absPath)}
                      >
                        <Eye className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="ls-btn ls-btn-ghost px-1.5"
                        aria-label="Reveal in Finder"
                        onClick={() => void desktop.reveal(member.absPath)}
                      >
                        <FolderOpen className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** A large preview; a video plays inline on request so two encodes can be compared. */
function MemberPreview({ row }: { row: FileRow }) {
  const [playing, setPlaying] = useState(false);

  if (row.kind === "video" && playing) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: archive videos have no captions to offer.
      <video
        src={mediaUrl(row.absPath)}
        controls
        autoPlay
        className="aspect-video w-full bg-black object-contain"
      />
    );
  }

  return (
    <div className="relative flex aspect-video items-center justify-center bg-zinc-100 dark:bg-zinc-900">
      {row.probeError === null && (row.kind === "image" || row.kind === "video") ? (
        <img
          src={thumbnailUrl(row.absPath, 512)}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain"
        />
      ) : (
        <Thumbnail row={row} size={64} />
      )}
      {row.kind === "video" ? (
        <button
          type="button"
          aria-label="Play"
          onClick={() => setPlaying(true)}
          className="absolute inset-0 flex items-center justify-center text-white/90 hover:text-white"
        >
          <Play className="size-8 drop-shadow" />
        </button>
      ) : null}
    </div>
  );
}
