import type {
  HoldingItem,
  PlanId,
  PlanKind,
  PlanStep,
  PlanStepAction,
  PlanSummary,
  RootId,
} from "@latch-works/glazier-core/contract";
import {
  Archive,
  ArrowRightLeft,
  Copy,
  FolderInput,
  type LucideIcon,
  PencilLine,
  Shrink,
  Sparkles,
  VolumeX,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Spinner, StartTruncate } from "../../../../../ui/ui";
import { canUndo } from "../../lib/actions";
import { call } from "../../lib/api";
import { useEngineQuery } from "../../lib/engine-state";
import { formatCount, plural, relativeTo } from "../../lib/format";
import { LoadMore, usePages } from "./paging";
import { Thumb } from "./Thumb";

const KIND_ICONS = {
  hold: Archive,
  move: FolderInput,
  rename: PencilLine,
  "fix-extension": PencilLine,
  optimize: ArrowRightLeft,
  reencode: ArrowRightLeft,
  "strip-audio": VolumeX,
  "resolve-duplicates": Copy,
  "clean-junk": Sparkles,
  "remove-empty-folders": Sparkles,
  cleanup: Sparkles,
  "shrink-videos": Shrink,
} as const satisfies Record<PlanKind, LucideIcon>;

/** The 32 px tile that says what kind of change a row is. */
export function PlanIcon({ kind }: { kind: PlanKind }) {
  const Icon = KIND_ICONS[kind];

  return (
    <span className="pointer-events-none flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300">
      <Icon className="size-4" />
    </span>
  );
}

const ACTION_LABELS = {
  hold: "To holding",
  move: "Moved",
  rename: "Renamed",
  "convert-avif": "To AVIF",
  "convert-animation": "To MP4",
  "convert-video": "To MP4",
  "remove-folder": "Folder removed",
} as const satisfies Record<PlanStepAction, string>;

const STEP_STATUS = {
  pending: "Not run",
  done: null,
  skipped: "Skipped",
  failed: "Failed",
  undone: "Undone",
} as const satisfies Record<PlanStep["status"], string | null>;

/** How many steps an expanded row lists before "Show all". */
const PREVIEW_STEPS = 8;

const STEP_PAGE = 500;

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

function StepRow({ step, rootPath }: { step: PlanStep; rootPath: string | undefined }) {
  const status = STEP_STATUS[step.status];
  const target = step.toPath && step.action !== "hold" ? fileName(step.toPath) : null;

  return (
    <li
      data-step-status={step.status}
      className="flex h-9 items-center gap-3 border-t lw-divider pr-4 pl-[60px] text-[13px] first:border-t-0"
    >
      <span className="lw-caption w-24 shrink-0">{ACTION_LABELS[step.action]}</span>
      <StartTruncate text={relativeTo(rootPath, step.fromPath)} className="min-w-0 flex-1" />
      {target ? (
        <span className="lw-caption max-w-[35%] shrink-0 truncate" title={step.toPath ?? undefined}>
          → {target}
        </span>
      ) : null}
      {status ? (
        <span
          title={step.message ?? undefined}
          className={`shrink-0 text-xs ${
            step.status === "failed" || step.status === "skipped"
              ? "text-amber-700 dark:text-amber-300"
              : "text-zinc-500"
          }`}
        >
          {status}
        </span>
      ) : null}
    </li>
  );
}

/** A plan's steps, eight at first and every one after "Show all". */
export function PlanSteps({ plan, rootPath }: { plan: PlanSummary; rootPath: string | undefined }) {
  const [all, setAll] = useState(false);
  const preview = useEngineQuery("planSteps", { planId: plan.id, offset: 0, limit: PREVIEW_STEPS });

  const everything = usePages(
    all ? `steps:${plan.id}` : null,
    (offset, limit) => call("planSteps", { planId: plan.id, offset, limit }),
    STEP_PAGE,
  );

  const pages = everything.pages;
  const steps = pages ? pages.flatMap((page) => page.steps) : (preview.data?.steps ?? []);
  const total = preview.data?.total ?? 0;
  const lastPage = pages?.at(-1);

  if (!preview.data) {
    return <div className="h-9" />;
  }

  return (
    <ul>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} rootPath={rootPath} />
      ))}
      {!all && total > steps.length ? (
        <li className="flex h-9 items-center border-t lw-divider pl-[52px]">
          <button
            type="button"
            className="lw-btn lw-btn-ghost lw-btn-sm"
            onClick={() => setAll(true)}
          >
            Show all {formatCount(total)}
          </button>
        </li>
      ) : null}
      {all && !pages ? (
        <li className="flex h-9 items-center border-t lw-divider pl-[60px]">
          <Spinner />
        </li>
      ) : null}
      {pages && lastPage && lastPage.steps.length === STEP_PAGE ? (
        <li key={pages.length}>
          <LoadMore onVisible={everything.loadMore} />
        </li>
      ) : null}
    </ul>
  );
}

/** The path a duplicate's hold reason names as the copy that stayed: "Duplicate of a/b.jpg". */
function keeperOf(reason: string): string | null {
  return /^Duplicate of (.+)$/.exec(reason)?.[1] ?? null;
}

function folderOf(relPath: string): string {
  const cut = relPath.search(/[\\/][^\\/]*$/);

  return cut === -1 ? "" : relPath.slice(0, cut);
}

function SetRow({
  plan,
  held,
  rootPath,
  rootName,
  onUndo,
}: {
  plan: PlanSummary;
  held: HoldingItem | undefined;
  rootPath: string | undefined;
  rootName: string;
  onUndo: (plan: PlanSummary) => Promise<void>;
}) {
  const first = useEngineQuery("planSteps", { planId: plan.id, offset: 0, limit: 1 });
  const [busy, setBusy] = useState(false);
  const keeper = held ? keeperOf(held.reason) : null;
  const removed = first.data?.steps[0]?.fromPath ?? null;

  // The copy that stayed is on disk; the held one, or a restored one, stands in for it.
  const picture =
    keeper !== null && rootPath
      ? `${rootPath.replace(/[\\/]+$/, "")}/${keeper}`
      : (held?.holdPath ?? removed);

  const name = keeper !== null ? fileName(keeper) : removed ? fileName(removed) : plan.title;

  const detail = [
    plan.count > 1 ? plural(plan.count, "set") : null,
    keeper !== null ? `kept ${folderOf(keeper) || rootName}` : null,
    plan.held.files > 0 ? `removed ${formatCount(plan.held.files)}` : null,
    plan.status === "undone" ? "undone" : null,
  ].filter(Boolean);

  return (
    <li className="group flex h-12 items-center gap-3 border-t lw-divider pr-4 pl-[60px] first:border-t-0">
      <Thumb path={picture} size={96} className="size-8 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[13px] ${plan.status === "undone" ? "text-zinc-500" : ""}`}
          title={keeper ?? removed ?? undefined}
        >
          {name}
        </p>
        <p className="lw-caption truncate">{detail.join(" · ")}</p>
      </div>
      {canUndo(plan) ? (
        <button
          type="button"
          className="lw-btn lw-btn-secondary lw-btn-sm opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
          disabled={busy}
          onClick={async () => {
            setBusy(true);

            try {
              await onUndo(plan);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : null}
          Undo
        </button>
      ) : null}
    </li>
  );
}

/**
 * The sets of a run of duplicate resolutions, one row each with its own Undo. Each set is its own
 * plan; what stayed comes from the hold reason of the copies it put in holding.
 */
export function ResolveSets({
  plans,
  rootId,
  rootPath,
  rootName,
  onUndo,
}: {
  plans: readonly PlanSummary[];
  rootId: RootId;
  rootPath: string | undefined;
  rootName: string;
  onUndo: (plan: PlanSummary) => Promise<void>;
}) {
  const holding = useEngineQuery("listHolding", { rootId, offset: 0, limit: 500 });

  const heldByPlan = useMemo(() => {
    const byPlan = new Map<PlanId, HoldingItem>();

    for (const item of holding.data?.items ?? []) {
      if (item.planId !== null && !byPlan.has(item.planId)) {
        byPlan.set(item.planId, item);
      }
    }

    return byPlan;
  }, [holding.data]);

  return (
    <ul>
      {plans.map((plan) => (
        <SetRow
          key={plan.id}
          plan={plan}
          held={heldByPlan.get(plan.id)}
          rootPath={rootPath}
          rootName={rootName}
          onUndo={onUndo}
        />
      ))}
    </ul>
  );
}
