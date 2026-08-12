import { GET_GATHER_EXECUTOR_STATUS } from "../shared/gather-run-messages";

const OFFSCREEN_PATH = "offscreen/offscreen.html";

interface OffscreenPlatform {
  getContexts(documentUrl: string): Promise<unknown[]>;
  getUrl(path: string): string;
  createDocument(options: chrome.offscreen.CreateParameters): Promise<void>;
  sendMessage(message: unknown): Promise<unknown>;
}

const chromeOffscreenPlatform: OffscreenPlatform = {
  getContexts: (documentUrl) =>
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [documentUrl]
    }),
  getUrl: (path) => chrome.runtime.getURL(path),
  createDocument: (options) => chrome.offscreen.createDocument(options),
  sendMessage: (message) => chrome.runtime.sendMessage(message)
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

  async getActiveRunIds(): Promise<string[]> {
    try {
      if (!(await this.isOpen())) {
        return [];
      }

      const response = (await this.platform.sendMessage({
        type: GET_GATHER_EXECUTOR_STATUS,
        target: "offscreen"
      })) as { activeRunIds?: unknown } | undefined;
      return Array.isArray(response?.activeRunIds)
        ? response.activeRunIds.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
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
