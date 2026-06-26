import type { LockstepRunEvent } from "../../shared/types";

export type RunProgressStage = "idle" | "scanning" | "hashing" | "transfer" | "complete";

export interface RunProgressState {
  stage: RunProgressStage;
  current: number;
  total: number;
  currentPath: string;
  currentAction: string;
  filesFound: number;
  skipped: number;
  bytesHashed: number;
  fileSize: number;
  phaseLabel: string;
}

export const emptyRunProgress = (): RunProgressState => ({
  stage: "idle",
  current: 0,
  total: 0,
  currentPath: "",
  currentAction: "",
  filesFound: 0,
  skipped: 0,
  bytesHashed: 0,
  fileSize: 0,
  phaseLabel: "",
});

function formatPhaseLabel(stage: RunProgressStage, current: number, total: number): string {
  if (stage === "scanning") {
    return "Scanning archive";
  }
  if (stage === "hashing") {
    return "Hashing files";
  }
  if (stage === "transfer" && total > 0) {
    return `Transferring ${current} of ${total}`;
  }
  if (stage === "transfer") {
    return "Transferring files";
  }
  if (stage === "complete") {
    return "Run complete";
  }
  return "Working…";
}

export function applyRunEvent(
  progress: RunProgressState,
  event: LockstepRunEvent,
): RunProgressState {
  if (event.type === "scan-progress") {
    const { stage, filesFound, skipped, path, bytesHashed, fileSize } = event.progress;
    return {
      ...progress,
      stage,
      filesFound,
      skipped,
      currentPath: path ?? "",
      bytesHashed: bytesHashed ?? 0,
      fileSize: fileSize ?? 0,
      phaseLabel: formatPhaseLabel(stage, progress.current, progress.total),
    };
  }

  if (event.type === "item-success" || event.type === "item-failure") {
    return {
      ...progress,
      stage: "transfer",
      current: event.current,
      total: event.total,
      currentPath: event.path,
      currentAction: event.action,
      phaseLabel: formatPhaseLabel("transfer", event.current, event.total),
    };
  }

  if (event.type === "complete") {
    return {
      ...progress,
      stage: "complete",
      phaseLabel: event.summary.message ?? formatPhaseLabel("complete", progress.current, progress.total),
    };
  }

  if (event.type === "cancelled") {
    return {
      ...progress,
      stage: "complete",
      phaseLabel: "Run cancelled",
    };
  }

  return progress;
}

export function progressPercent(progress: RunProgressState): number | null {
  if (progress.stage === "transfer" && progress.total > 0) {
    return Math.min(100, Math.round((progress.current / progress.total) * 100));
  }

  if (progress.stage === "hashing" && progress.fileSize > 0) {
    return Math.min(100, Math.round((progress.bytesHashed / progress.fileSize) * 100));
  }

  if (progress.stage === "scanning") {
    return null;
  }

  if (progress.stage === "complete") {
    return 100;
  }

  return null;
}
