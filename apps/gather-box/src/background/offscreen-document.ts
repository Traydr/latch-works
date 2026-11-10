import { OFFSCREEN_DOCUMENT_PATH } from "../shared/constants";
import { GET_GATHER_EXECUTOR_STATUS, sendExecutorRequest } from "../shared/protocol/executor";

/** What the executor is running; `unknown` when it exists but did not answer. */
export type ExecutorStatus = { activeRunId: string | null } | "unknown";

export class OffscreenDocument {
  private creating: Promise<void> | null = null;

  ensure(): Promise<void> {
    if (this.creating) {
      return this.creating;
    }

    this.creating = this.discoverOrCreate().finally(() => {
      this.creating = null;
    });

    return this.creating;
  }

  async isOpen(): Promise<boolean> {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });

    return contexts.length > 0;
  }

  async getExecutorStatus(): Promise<ExecutorStatus> {
    const open = await this.isOpen().catch(() => null);

    if (open === null) {
      return "unknown";
    }

    if (!open) {
      return { activeRunId: null };
    }

    const status = await sendExecutorRequest({
      type: GET_GATHER_EXECUTOR_STATUS,
      target: "offscreen",
    });

    return "activeRunId" in status ? status : "unknown";
  }

  private async discoverOrCreate(): Promise<void> {
    if (await this.isOpen()) {
      return;
    }

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["BLOBS", "DOM_PARSER"],
      justification: "Fetch and materialize Gather Outputs in the selected local archive.",
    });
  }
}
