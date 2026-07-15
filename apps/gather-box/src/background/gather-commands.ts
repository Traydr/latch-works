import type { GatherRunStartOutcome } from "../shared/gather-run";
import type { GatherRunCoordinator } from "./gather-run-coordinator";

export type ToggleGatherBoxOutcome =
  | { outcome: "opened" }
  | { outcome: "closed" }
  | { outcome: "target-unavailable" }
  | { outcome: "failed"; message: string };

interface SidePanelAdapter {
  open(options: { windowId: number }): Promise<void>;
  close(options: { windowId: number }): Promise<void>;
}

export class GatherCommands {
  private readonly openWindowIds = new Set<number>();

  constructor(
    private readonly runs: Pick<GatherRunCoordinator, "startForTab">,
    private readonly sidePanel: SidePanelAdapter = chrome.sidePanel
  ) {}

  panelOpened(windowId: number): void {
    this.openWindowIds.add(windowId);
  }

  panelClosed(windowId: number): void {
    this.openWindowIds.delete(windowId);
  }

  async toggle(tab: chrome.tabs.Tab): Promise<ToggleGatherBoxOutcome> {
    if (tab.windowId === undefined) {
      return { outcome: "target-unavailable" };
    }

    try {
      if (this.openWindowIds.has(tab.windowId)) {
        await this.sidePanel.close({ windowId: tab.windowId });
        this.panelClosed(tab.windowId);
        return { outcome: "closed" };
      }
      await this.sidePanel.open({ windowId: tab.windowId });
      this.panelOpened(tab.windowId);
      return { outcome: "opened" };
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : "Could not toggle Gather Box."
      };
    }
  }

  gather(tab: chrome.tabs.Tab): Promise<GatherRunStartOutcome> {
    if (tab.windowId === undefined) {
      return Promise.resolve({ outcome: "target-unavailable" });
    }

    // Opening begins synchronously in the command event turn so Chrome retains user activation.
    const opening = this.sidePanel.open({ windowId: tab.windowId });
    const starting = this.runs.startForTab(tab);
    return Promise.allSettled([opening, starting]).then(([, result]) =>
      result.status === "fulfilled"
        ? result.value
        : {
            outcome: "failed" as const,
            message: result.reason instanceof Error ? result.reason.message : "Could not start Gather Run."
          }
    );
  }
}
