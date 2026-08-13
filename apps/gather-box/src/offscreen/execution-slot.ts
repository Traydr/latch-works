export type GatherExecutionStart = "started" | "duplicate" | "busy";

export class GatherExecutionSlot {
  private active: { runId: string; controller: AbortController } | null = null;

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /**
   * `onReleased` runs once the slot is free again, so work that can dispatch the next run — such as
   * reporting this one as finished — never races the release.
   */
  start(
    runId: string,
    execute: (signal: AbortSignal) => Promise<void>,
    onReleased?: () => void
  ): GatherExecutionStart {
    if (this.active?.runId === runId) {
      return "duplicate";
    }
    if (this.active) {
      return "busy";
    }

    const controller = new AbortController();
    this.active = { runId, controller };
    void Promise.resolve()
      .then(() => execute(controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (this.active?.runId === runId) {
          this.active = null;
        }
        try {
          onReleased?.();
        } catch {
          // Releasing the slot must not depend on how the run was reported.
        }
      });
    return "started";
  }

  abort(runId: string): boolean {
    if (this.active?.runId !== runId) {
      return false;
    }
    this.active.controller.abort();
    return true;
  }
}
