import type { FileFormat, FileRow, RootId, Tidy } from "@latch-works/glazier-core/contract";
import { ChevronRight, CircleCheck, Repeat2 } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState, Kbd, Menu, MenuCheck, TopBar } from "../../../../ui/ui";
import { MediaTile } from "../components/tidy/MediaTile";
import { RunProgress } from "../components/tidy/RunProgress";
import { useActions } from "../lib/actions";
import {
  CONVERT_GROUPS,
  type ConvertGroup,
  describeEstimate,
  type Estimate,
  estimateRatio,
  groupTotals,
  useConvertEstimates,
  useConvertGroups,
} from "../lib/convert-options";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, plural } from "../lib/format";
import { isCommandKey, useViewKeys } from "../lib/hotkeys";
import { useNavigation } from "../lib/navigation";

/** Tiles shown per section; the rest are a link to the Library. */
const TILE_LIMIT = 60;

/** Rows read per section to find its tiles among files of other categories. */
const SECTION_PAGE = 300;

const SOURCE = "convert";

const LINK =
  "underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:decoration-zinc-600 dark:hover:text-zinc-100";

/** The files a section's query reads, and which of them belong to it. */
const SECTION_FILES = {
  pictures: {
    kind: "image",
    formats: ["png", "jpeg", "webp", "bmp"],
    belongs: (row: FileRow) => (row.frames ?? 1) <= 1,
  },
  animations: {
    kind: "image",
    formats: ["gif", "png", "webp"],
    belongs: (row: FileRow) => row.format === "gif" || (row.frames ?? 1) > 1,
  },
  videos: {
    kind: "video",
    formats: [],
    // MP4 under another extension only needs renaming, which Clean up does.
    belongs: (row: FileRow) => !(row.format === "mp4" && row.ext.toLowerCase() !== "mp4"),
  },
} as const satisfies Record<
  ConvertGroup["id"],
  { kind: "image" | "video"; formats: readonly FileFormat[]; belongs: (row: FileRow) => boolean }
>;

/** The reasons a file waits for duplicate review rather than being left out for good. */
const WAITING_REASONS: ReadonlySet<string> = new Set([
  "Identical copies (resolve duplicates first)",
  "Similar versions (review them first)",
  "Not checked for similar versions yet",
]);

/** Why the engine left files out of Convert, said the way the owner would say it. */
const SKIP_WORDS = new Map<string, readonly [string, string]>([
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
  ["Already as small as they get", ["came out no smaller", "came out no smaller"]],
  ["Won't decode", ["won't open", "won't open"]],
  [
    "A file with the target name already exists",
    ["would take a name already in use", "would take a name already in use"],
  ],
]);

/** One line per reason files stay as they are, plus kinds switched off in Options. */
function leftReasons(tidy: Tidy, off: readonly ConvertGroup[]): string[] {
  const skipped = tidy.convert.skipped.flatMap((entry) => {
    if (entry.files === 0) {
      return [];
    }

    const words = SKIP_WORDS.get(entry.reason);

    return words
      ? [`${formatCount(entry.files)} ${entry.files === 1 ? words[0] : words[1]}`]
      : [`${formatCount(entry.files)}: ${entry.reason.replace(/\.$/, "")}`];
  });

  const switchedOff = off.flatMap((group) => {
    const { files } = groupTotals(tidy, group);

    return files > 0
      ? [`${plural(files, group.noun[0], group.noun[1])} switched off in Options`]
      : [];
  });

  return [...skipped, ...switchedOff];
}

export function ConvertView({ rootId }: { rootId: RootId }) {
  const tidy = useEngineQuery("tidy", { rootId });
  const { capabilities } = useEngine();
  const actions = useActions();
  const { enabled, setEnabled } = useConvertGroups();
  const { estimate } = useConvertEstimates(rootId, tidy.data);
  const [leftOpen, setLeftOpen] = useState(false);
  const leftSection = useRef<HTMLElement>(null);
  const data = tidy.data;
  const job = actions.jobFor(SOURCE);
  const chosen = CONVERT_GROUPS.filter((group) => enabled.has(group.id));
  const off = CONVERT_GROUPS.filter((group) => !enabled.has(group.id));

  const sections = data ? chosen.filter((group) => groupTotals(data, group).files > 0) : [];

  const categories = chosen.flatMap((group) => [...group.categories]);
  const files = data ? sections.reduce((sum, group) => sum + groupTotals(data, group).files, 0) : 0;

  const convert = () =>
    void actions.perform(
      { kind: "optimize", rootId, categories, fileIds: null },
      { source: SOURCE },
    );

  useViewKeys((event) => {
    if (isCommandKey(event) && event.key === "Enter" && files > 0 && job === null) {
      convert();

      return true;
    }

    return false;
  });

  if (!data) {
    return (
      <>
        <TopBar title="Convert" />
        {tidy.error ? <EmptyState title={tidy.error} /> : <div className="flex-1" />}
      </>
    );
  }

  const bytes = sections.reduce((sum, group) => sum + groupTotals(data, group).bytes, 0);
  const reasons = leftReasons(data, off);

  const left =
    data.convert.skipped.reduce((sum, entry) => sum + entry.files, 0) +
    off.reduce((sum, group) => sum + groupTotals(data, group).files, 0);

  const noVideoEncoder = capabilities !== null && !capabilities.video.avc && !capabilities.ffmpeg;

  // Files held back for duplicate review, said in the top bar, since the list that explains them
  // sits below the fold.
  const waiting = data.convert.skipped.reduce(
    (sum, entry) => sum + (WAITING_REASONS.has(entry.reason) ? entry.files : 0),
    0,
  );

  const showLeft = () => {
    setLeftOpen(true);
    window.requestAnimationFrame(() =>
      leftSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <>
      <TopBar
        title="Convert"
        meta={
          files > 0 ? (
            <>
              {plural(files, "file")} · {formatBytes(bytes)}
              {waiting > 0 ? (
                <>
                  {" · "}
                  <button type="button" className={LINK} onClick={showLeft}>
                    {formatCount(waiting)} wait for duplicate review
                  </button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        <Menu label="Options">
          {() => (
            <>
              {CONVERT_GROUPS.map((group) => (
                <MenuCheck
                  key={group.id}
                  label={group.label}
                  count={formatCount(groupTotals(data, group).files)}
                  checked={enabled.has(group.id)}
                  onChange={(checked) => setEnabled(group.id, checked)}
                />
              ))}
              <p className="gz-caption max-w-[264px] px-2.5 pt-1.5 pb-1">
                Pictures use AVIF at quality 70. Video tracks MP4 can hold are copied as they are.
              </p>
            </>
          )}
        </Menu>
        {job ? (
          <RunProgress job={job} />
        ) : (
          <button
            type="button"
            className="gz-btn gz-btn-primary gz-btn-lg"
            disabled={files === 0}
            onClick={convert}
          >
            Convert {formatCount(files)} <Kbd>⌘↩</Kbd>
          </button>
        )}
      </TopBar>

      {files === 0 && !job ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <EmptyState
            icon={chosen.length === 0 ? Repeat2 : CircleCheck}
            title={chosen.length === 0 ? "Nothing chosen to convert" : "Everything is AVIF or MP4"}
          >
            {chosen.length === 0 ? (
              "Turn a kind of file on in Options."
            ) : left > 0 ? (
              <button
                type="button"
                className={LINK}
                aria-expanded={leftOpen}
                onClick={() => setLeftOpen((open) => !open)}
              >
                {plural(left, "file")} left as they are
              </button>
            ) : null}
          </EmptyState>
          {leftOpen && chosen.length > 0 && reasons.length > 0 ? (
            <div className="mx-auto w-full max-w-[760px] px-6 pb-10">
              <LeftList reasons={reasons} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-28">
          {sections.map((group) => (
            <Section
              key={group.id}
              rootId={rootId}
              group={group}
              tidy={data}
              estimate={estimate(group.categories)}
              warning={
                group.id === "videos" && noVideoEncoder ? "No H.264 encoder on this machine" : null
              }
            />
          ))}
          {left > 0 ? (
            <section data-section="left" ref={leftSection} className="scroll-mt-2">
              <button
                type="button"
                aria-expanded={leftOpen}
                onClick={() => setLeftOpen((open) => !open)}
                className="gz-focus sticky top-0 z-10 flex h-9 w-full items-center gap-1.5 bg-white text-left text-[13px] font-medium dark:bg-zinc-950"
              >
                <ChevronRight
                  className={`size-3.5 text-zinc-400 transition-transform duration-150 ${
                    leftOpen ? "rotate-90" : ""
                  }`}
                />
                {formatCount(left)} left as they are
              </button>
              {leftOpen ? <LeftList reasons={reasons} /> : null}
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

function LeftList({ reasons }: { reasons: readonly string[] }) {
  return (
    <ul className="gz-card">
      {reasons.map((reason, index) => (
        <li
          key={reason}
          className={`flex h-11 items-center px-4 text-[13px] ${index > 0 ? "border-t gz-divider" : ""}`}
        >
          {reason}
        </li>
      ))}
    </ul>
  );
}

function Section({
  rootId,
  group,
  tidy,
  estimate,
  warning,
}: {
  rootId: RootId;
  group: ConvertGroup;
  tidy: Tidy;
  estimate: Estimate;
  warning: string | null;
}) {
  const { openLibrary } = useNavigation();
  const spec = SECTION_FILES[group.id];
  const { files, bytes } = groupTotals(tidy, group);
  const ratio = estimateRatio(estimate);

  const page = useEngineQuery("listFiles", {
    rootId,
    search: "",
    kinds: [spec.kind],
    formats: [...spec.formats],
    audioStates: [],
    flags: ["convertible"],
    dir: null,
    sort: "path",
    descending: false,
    offset: 0,
    limit: SECTION_PAGE,
  });

  const tiles = (page.data?.rows ?? []).filter(spec.belongs).slice(0, TILE_LIMIT);
  const more = files - tiles.length;

  return (
    <section data-section={group.id}>
      <header className="sticky top-0 z-10 flex h-9 items-center gap-3 bg-white dark:bg-zinc-950">
        <h2 className="text-[13px] font-medium">
          {plural(files, group.noun[0], group.noun[1])} → {group.target}
        </h2>
        {warning ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">{warning}</span>
        ) : null}
        <span className="gz-caption ml-auto">{describeEstimate(bytes, estimate)}</span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-3 gap-y-4 pt-1 pb-6">
        {tiles.map((row) => (
          <MediaTile key={row.id} row={row} ratio={ratio} />
        ))}
      </div>
      {more > 0 && page.data ? (
        <button
          type="button"
          className={`-mt-3 mb-6 text-[13px] text-zinc-500 dark:text-zinc-400 ${LINK}`}
          onClick={() => openLibrary({ flags: ["convertible"], kinds: [spec.kind] })}
        >
          and {formatCount(more)} more
        </button>
      ) : null}
    </section>
  );
}
