import { randomUUID } from "node:crypto";
import {
  type LockstepObserver,
  type LockstepPlan,
  type LockstepRunEvent,
  type LockstepRunSummary,
  planSync,
  pruneDeleted,
  pushChanges,
  doctor as runDoctor,
  UnfinalizedSyncRunError,
} from "@latch-works/lockstep-core";
import type {
  ActiveRun,
  DoctorResult,
  PruneRequest,
  LockstepPlan as PublicLockstepPlan,
  RunRequest,
} from "../../shared/types";
import { RunCancelledError, toError } from "../errors";
import type { ProfileService } from "./profileService";

/** The lockstep-core entry points a run needs, injectable so tests can drive them. */
export interface LockstepCore {
  doctor: typeof runDoctor;
  planSync: typeof planSync;
  pruneDeleted: typeof pruneDeleted;
  pushChanges: typeof pushChanges;
}

const lockstepCore = {
  doctor: runDoctor,
  planSync,
  pruneDeleted,
  pushChanges,
} satisfies LockstepCore;

/** The last plan made for a profile, kept here so Prune applies what the user reviewed. */
interface ReviewedPlan {
  apiUrl: string;
  plan: LockstepPlan;
  planId: string;
  sourceRoot: string;
}

/** The part of the main window run events go to; `BrowserWindow` provides it. */
export interface RunEventWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: "lockstep:run-event", event: LockstepRunEvent): void };
}

type RunCredentials = { apiToken: string; apiUrl: string; sourceRoot: string };

export class RunService {
  private abortController: AbortController | null = null;
  private activeRun: ActiveRun | null = null;
  /** Profile changes accepted but not yet saved; a run waits for none. */
  private pendingProfileChanges = 0;
  private readonly reviewedPlans = new Map<string, ReviewedPlan>();

  constructor(
    private readonly profileService: ProfileService,
    private readonly getMainWindow: () => RunEventWindow | null,
    private readonly core: LockstepCore = lockstepCore,
  ) {}

  /** The run in progress, so a window opened mid-run can show it and offer Cancel. */
  getActiveRun(): ActiveRun | null {
    return this.activeRun;
  }

  /**
   * Edits, deletes, or selects a profile only while no run is going, and holds runs off until the
   * change is saved: a run reads its profile once and records its result on it. Resolves to
   * `undefined`, without calling `change`, while a run is in progress.
   */
  async changeProfileWhileIdle<T>(change: () => Promise<T>): Promise<T | undefined> {
    if (this.activeRun) {
      return undefined;
    }

    this.pendingProfileChanges += 1;

    try {
      return await change();
    } finally {
      this.pendingProfileChanges -= 1;
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async plan(request: RunRequest): Promise<PublicLockstepPlan> {
    return this.runWithCore("plan", request, async (credentials, observer, signal) => {
      const plan = await this.core.planSync(
        {
          apiToken: credentials.apiToken,
          apiUrl: credentials.apiUrl,
          hashFiles: request.hashFiles,
          signal,
          sourceRoot: credentials.sourceRoot,
        },
        observer,
      );

      await this.profileService.recordLastRun(request.profileId, {
        action: "plan",
        completedAt: new Date().toISOString(),
        failed: 0,
        planCounts: plan.counts,
        profileId: request.profileId,
        pushed: 0,
        status: "completed",
      });

      const planId = randomUUID();
      this.reviewedPlans.set(request.profileId, {
        apiUrl: credentials.apiUrl,
        plan,
        planId,
        sourceRoot: credentials.sourceRoot,
      });

      // The renderer needs each item's action, path, and size, not the scanned file records.
      const items = plan.items.map((item) => ({
        action: item.action,
        path: item.path,
        size: item.local?.size ?? item.remote?.size,
      }));

      return { ...plan, items, planId };
    });
  }

  async push(request: RunRequest): Promise<LockstepRunSummary> {
    return this.runWithCore("push", request, async (credentials, observer, signal) => {
      const result = await this.core.pushChanges(
        {
          apiToken: credentials.apiToken,
          apiUrl: credentials.apiUrl,
          hashMode: "remote-aware",
          maxChanges: request.maxChanges,
          signal,
          sourceRoot: credentials.sourceRoot,
        },
        observer,
      );

      const summary: LockstepRunSummary = {
        action: "push",
        completedAt: new Date().toISOString(),
        failed: result.failed,
        planCounts: result.plan.counts,
        profileId: request.profileId,
        pushed: result.pushed,
        status: result.failed > 0 ? "failed" : "completed",
      };

      await this.profileService.recordLastRun(request.profileId, summary);

      return summary;
    });
  }

  /**
   * Deletes the remote entries listed as deletes in the plan `request.planId` names. That plan is
   * used once: a second Prune needs a new Plan.
   */
  async prune(request: PruneRequest): Promise<LockstepRunSummary> {
    return this.runWithCore("prune", request, async (credentials, observer, signal) => {
      const reviewed = this.takeReviewedPlan(request, credentials);

      const result = await this.core.pruneDeleted(
        {
          apiToken: credentials.apiToken,
          apiUrl: credentials.apiUrl,
          plan: reviewed.plan,
          signal,
        },
        observer,
      );

      const summary: LockstepRunSummary = {
        action: "prune",
        completedAt: new Date().toISOString(),
        failed: result.failed,
        planCounts: result.plan.counts,
        profileId: request.profileId,
        pushed: result.pruned,
        skipped: result.skipped,
        status: result.failed > 0 ? "failed" : "completed",
      };

      await this.profileService.recordLastRun(request.profileId, summary);

      return summary;
    });
  }

  /** Checks the profile's source folder and server; Cancel stops it like any other run. */
  async doctor(profileId: string): Promise<DoctorResult> {
    return this.ownRun("doctor", profileId, async (observer, signal) => {
      const profile = this.profileService.getProfile(profileId);

      if (!profile) {
        throw new Error("Profile not found.");
      }

      const result = await this.core.doctor(
        {
          apiToken: this.profileService.getApiToken(profileId),
          apiUrl: profile.apiUrl,
          signal,
          sourceRoot: profile.sourceRoot,
        },
        {
          // A cancelled snapshot check reports a failed check; the run reports the cancel instead.
          onEvent: (event) => {
            if (!signal.aborted) {
              observer.onEvent(event);
            }
          },
        },
      );

      signal.throwIfAborted();

      await this.profileService.recordLastRun(profileId, {
        action: "doctor",
        completedAt: new Date().toISOString(),
        failed: result.ok ? 0 : 1,
        message: result.ok ? "All checks passed." : "Some checks failed.",
        profileId,
        pushed: 0,
        status: result.ok ? "completed" : "failed",
      });

      return result;
    });
  }

  /**
   * Hands out the profile's reviewed plan once. It must be the plan the renderer names and still
   * describe the profile's server and source folder.
   */
  private takeReviewedPlan(request: PruneRequest, credentials: RunCredentials): ReviewedPlan {
    const reviewed = this.reviewedPlans.get(request.profileId);

    if (!reviewed || reviewed.planId !== request.planId) {
      throw new Error("This plan is no longer current. Run Plan again and review it first.");
    }

    this.reviewedPlans.delete(request.profileId);

    if (reviewed.apiUrl !== credentials.apiUrl || reviewed.sourceRoot !== credentials.sourceRoot) {
      throw new Error(
        "The profile's server or source folder changed since this plan. Run Plan again.",
      );
    }

    return reviewed;
  }

  private async runWithCore<T>(
    operation: LockstepRunSummary["action"],
    request: { profileId: string },
    runner: (
      credentials: RunCredentials,
      observer: LockstepObserver,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    return this.ownRun(operation, request.profileId, (observer, signal) => {
      const profile = this.profileService.getProfile(request.profileId);

      if (!profile) {
        throw new Error("Profile not found.");
      }

      const apiToken = this.profileService.getApiToken(request.profileId);

      if (!apiToken) {
        throw new Error("API token is not configured for this profile.");
      }

      return runner(
        { apiToken, apiUrl: profile.apiUrl, sourceRoot: profile.sourceRoot },
        observer,
        signal,
      );
    });
  }

  /** Runs one operation at a time under the controller Cancel aborts. */
  private async ownRun<T>(
    operation: LockstepRunSummary["action"],
    profileId: string,
    runner: (observer: LockstepObserver, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.activeRun) {
      throw new Error("A sync run is already in progress.");
    }

    if (this.pendingProfileChanges > 0) {
      throw new Error("A profile change is still being saved. Try again when it finishes.");
    }

    this.activeRun = { action: operation, profileId };
    const abortController = new AbortController();
    this.abortController = abortController;
    let completeObserved = false;
    let reportedFailure: LockstepRunSummary | undefined;
    /** Held until the run is saved and released, so a window never sees it end while it is busy. */
    let completion: LockstepRunEvent | undefined;
    const baseObserver = this.createObserver();

    const observer: LockstepObserver = {
      onEvent: (event: LockstepRunEvent) => {
        // Push and prune plan first; only this operation's own completion ends the run.
        if (event.type === "complete" && event.summary.action === operation) {
          completeObserved = true;
          reportedFailure = event.summary.status === "failed" ? event.summary : undefined;
          completion = event;

          return;
        }

        baseObserver.onEvent(event);
      },
    };

    try {
      return await runner(observer, abortController.signal);
    } catch (error) {
      // A run the server still shows as running is a failure to act on, even after Cancel.
      const cancelled =
        abortController.signal.aborted && !(error instanceof UnfinalizedSyncRunError);

      if (cancelled && !completeObserved) {
        const summary: LockstepRunSummary = {
          action: operation,
          completedAt: new Date().toISOString(),
          failed: 0,
          profileId,
          pushed: 0,
          status: "cancelled",
        };

        observer.onEvent({ type: "cancelled" });
        observer.onEvent({ type: "complete", summary });
      }

      if (cancelled) {
        throw new RunCancelledError({ message: "Run cancelled.", operation });
      }

      if (reportedFailure) {
        // A push or prune whose items went through but whose sync run could not be finalized
        // reports that failure, naming the run, before it throws.
        await this.profileService.recordLastRun(profileId, reportedFailure);
      } else if (!completeObserved) {
        // Windows that attached mid-run learn the outcome only from events.
        observer.onEvent({
          type: "complete",
          summary: {
            action: operation,
            completedAt: new Date().toISOString(),
            failed: 0,
            message: toError(error).message,
            profileId,
            pushed: 0,
            status: "failed",
          },
        });
      }

      throw error;
    } finally {
      this.activeRun = null;
      this.abortController = null;

      if (completion) {
        baseObserver.onEvent(completion);
      }
    }
  }

  private createObserver(): LockstepObserver {
    return {
      onEvent: (event: LockstepRunEvent) => {
        const window = this.getMainWindow();

        if (!window || window.isDestroyed()) {
          return;
        }

        window.webContents.send("lockstep:run-event", event);
      },
    };
  }
}
