import * as z from "zod/mini";
import {
  GET_GATHER_EXECUTOR_STATUS,
  type GetGatherExecutorStatusMessage
} from "../shared/gather-run-messages";

const OFFSCREEN_PATH = "offscreen/offscreen.html";

/** The offscreen document runs at most one Gather Run at a time. */
const GatherExecutorStatusSchema = z.catch(
  z.object({ activeRunId: z.catch(z.nullable(z.string()), null) }),
  { activeRunId: null }
);

type GatherExecutorStatus = z.infer<typeof GatherExecutorStatusSchema>;

interface OffscreenPlatform {
  getContexts(documentUrl: string): Promise<chrome.runtime.ExtensionContext[]>;
  getUrl(path: string): string;
  createDocument(options: chrome.offscreen.CreateParameters): Promise<void>;
  sendMessage(message: GetGatherExecutorStatusMessage): Promise<GatherExecutorStatus>;
}

const chromeOffscreenPlatform: OffscreenPlatform = {
  getContexts: (documentUrl) =>
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [documentUrl]
    }),
  getUrl: (path) => chrome.runtime.getURL(path),
  createDocument: (options) => chrome.offscreen.createDocument(options),
  sendMessage: async (message) =>
    GatherExecutorStatusSchema.parse(await chrome.runtime.sendMessage(message))
};

export class OffscreenDocument {
  private creating: Promise<void> | null = null;

  constructor(private readonly platform: OffscreenPlatform = chromeOffscreenPlatform) {}

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
    const offscreenUrl = this.platform.getUrl(OFFSCREEN_PATH);
    const contexts = await this.platform.getContexts(offscreenUrl);
    return contexts.length > 0;
  }

  async getActiveRunId(): Promise<string | null> {
    try {
      if (!(await this.isOpen())) {
        return null;
      }

      const status = await this.platform.sendMessage({
        type: GET_GATHER_EXECUTOR_STATUS,
        target: "offscreen"
      });
      return status.activeRunId;
    } catch {
      return null;
    }
  }

  private async discoverOrCreate(): Promise<void> {
    const offscreenUrl = this.platform.getUrl(OFFSCREEN_PATH);
    const contexts = await this.platform.getContexts(offscreenUrl);
    if (contexts.length > 0) {
      return;
    }

    await this.platform.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS", "DOM_PARSER"],
      justification: "Fetch and materialize Gather Outputs in the selected local archive."
    });
  }
}
