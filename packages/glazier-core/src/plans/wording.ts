import type { PlanKind } from "../contract.js";
import { countOf } from "../format.js";

interface PlanWording {
  /** The verb once the plan ran: "Converted". */
  done: string;
  /** The verb while it runs: "Converting". */
  doing: string;
  one: string;
  many: string;
  /** What follows the count, such as " to holding". */
  tail: string;
}

const PLAN_WORDING = {
  hold: { done: "Moved", doing: "Moving", one: "file", many: "files", tail: " to holding" },
  move: { done: "Moved", doing: "Moving", one: "file", many: "files", tail: "" },
  rename: { done: "Renamed", doing: "Renaming", one: "file", many: "files", tail: "" },
  "fix-extension": {
    done: "Fixed",
    doing: "Fixing",
    one: "extension",
    many: "extensions",
    tail: "",
  },
  optimize: { done: "Converted", doing: "Converting", one: "file", many: "files", tail: "" },
  reencode: { done: "Re-encoded", doing: "Re-encoding", one: "video", many: "videos", tail: "" },
  "strip-audio": {
    done: "Removed",
    doing: "Removing",
    one: "audio track",
    many: "audio tracks",
    tail: "",
  },
  "resolve-duplicates": {
    done: "Resolved",
    doing: "Resolving",
    one: "duplicate set",
    many: "duplicate sets",
    tail: "",
  },
  "clean-junk": {
    done: "Moved",
    doing: "Moving",
    one: "junk file",
    many: "junk files",
    tail: " to holding",
  },
  "remove-empty-folders": {
    done: "Removed",
    doing: "Removing",
    one: "empty folder",
    many: "empty folders",
    tail: "",
  },
  cleanup: { done: "Cleaned up", doing: "Cleaning up", one: "item", many: "items", tail: "" },
  "shrink-videos": { done: "Shrank", doing: "Shrinking", one: "video", many: "videos", tail: "" },
} as const satisfies Record<PlanKind, PlanWording>;

/** What a plan is about, as its title and job labels count it. */
export interface PlanSubject {
  kind: PlanKind;
  count: number;
  /** The file a single rename renamed, which the wording names instead of counting. */
  singleName: string | null;
  /** For a plan that stopped or failed partway, how many of `count` finished. */
  finished: number | null;
}

function phrase(subject: PlanSubject, tense: "done" | "doing"): string {
  const wording: PlanWording = PLAN_WORDING[subject.kind];

  if (subject.kind === "rename" && subject.count === 1 && subject.singleName !== null) {
    return `${wording[tense]} ${subject.singleName}`;
  }

  const counted = countOf(subject.count, wording.one, wording.many);

  return subject.finished === null
    ? `${wording[tense]} ${counted}${wording.tail}`
    : `${wording[tense]} ${subject.finished.toLocaleString("en-US")} of ${counted}${wording.tail}`;
}

/**
 * The past-tense title history shows: "Converted 206 files", "Renamed IMG_1.png", or for a plan
 * cut short, "Converted 5 of 19 files".
 */
export function planTitle(subject: PlanSubject): string {
  return phrase(subject, "done");
}

/** The label of the job applying a plan: "Converting 206 files". */
export function applyLabel(subject: PlanSubject): string {
  return phrase(subject, "doing");
}

/** The label of the job undoing a plan: `Undoing “Converted 206 files”`. */
export function undoLabel(subject: PlanSubject): string {
  return `Undoing “${planTitle(subject)}”`;
}
