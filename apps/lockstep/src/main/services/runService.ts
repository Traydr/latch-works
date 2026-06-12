import {
  type LockstepObserver,
  type LockstepPlan,
  type LockstepRunEvent,
  type LockstepRunSummary,
  planSync,
  pruneDeleted,
  pushChanges,
  doctor as runDoctor,
} from "@latch-works/lockstep-core";
import type { BrowserWindow } from "electron";

import type { DoctorResult, RunRequest } from "../../shared/types";
import type { ProfileService } from "./profileService";

export class RunService {
  private abortController: AbortController | null = null;
  private running = false;

  constructor(
    private readonly profileService: ProfileService,
    private readonly getMainWindow: () => BrowserWindow | null,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async plan(request: RunRequest): Promise<LockstepPlan> {
    return this.runWithCore("plan", request, async (credentials, observer, signal) => {
      const plan = await planSync(
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

      return plan;
    });
  }

  async push(request: RunRequest): Promise<LockstepRunSummary> {
    return this.runWithCore("push", request, async (credentials, observer, signal) => {
      const result = await pushChanges(
        {
          apiToken: credentials.apiToken,
          apiUrl: credentials.apiUrl,
          hashFiles: true,
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

  async prune(request: RunRequest): Promise<LockstepRunSummary> {
    return this.runWithCore("prune", request, async (credentials, observer, signal) => {
      const result = await pruneDeleted(
        {
          apiToken: credentials.apiToken,
          apiUrl: credentials.apiUrl,
          maxChanges: request.maxChanges,
          signal,
          sourceRoot: credentials.sourceRoot,
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
        status: result.failed > 0 ? "failed" : "completed",
      };

      await this.profileService.recordLastRun(request.profileId, summary);
      return summary;
    });
  }

  async doctor(profileId: string): Promise<DoctorResult> {
    const profile = this.profileService.getProfile(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    const observer = this.createObserver();
    const result = await runDoctor(
      {
        apiToken: this.profileService.getApiToken(profileId),
        apiUrl: profile.apiUrl,
        sourceRoot: profile.sourceRoot,
      },
      observer,
    );

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
  }

  private async runWithCore<T>(
    operation: LockstepRunSummary["action"],
    request: RunRequest,
    runner: (
      credentials: { apiToken: string; apiUrl: string; sourceRoot: string },
      observer: LockstepObserver,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.running) {
      throw new Error("A sync run is already in progress.");
    }

    const profile = this.profileService.getProfile(request.profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }

    const apiToken = this.profileService.getApiToken(request.profileId);
    if (!apiToken) {
      throw new Error("API token is not configured for this profile.");
    }

    this.running = true;
    this.abortController = new AbortController();
    let completeObserved = false;
    const baseObserver = this.createObserver();
    const observer: LockstepObserver = {
      onEvent: (event: LockstepRunEvent) => {
        if (event.type === "complete") {
          completeObserved = true;
        }
        baseObserver.onEvent(event);
      },
    };

    try {
      return await runner(
        {
          apiToken,
          apiUrl: profile.apiUrl,
          sourceRoot: profile.sourceRoot,
        },
        observer,
        this.abortController.signal,
      );
    } catch (error) {
      if (this.abortController.signal.aborted && !completeObserved) {
        const summary: LockstepRunSummary = {
          action: operation,
          completedAt: new Date().toISOString(),
          failed: 0,
          profileId: request.profileId,
          pushed: 0,
          status: "cancelled",
        };
        observer.onEvent({ type: "cancelled" });
        observer.onEvent({ type: "complete", summary });
      }
      throw error;
    } finally {
      this.running = false;
      this.abortController = null;
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
