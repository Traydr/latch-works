const OFFSCREEN_PATH = "offscreen/offscreen.html";

interface OffscreenPlatform {
  getContexts(documentUrl: string): Promise<unknown[]>;
  getUrl(path: string): string;
  createDocument(options: chrome.offscreen.CreateParameters): Promise<void>;
}

const chromeOffscreenPlatform: OffscreenPlatform = {
  getContexts: (documentUrl) =>
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [documentUrl]
    }),
  getUrl: (path) => chrome.runtime.getURL(path),
  createDocument: (options) => chrome.offscreen.createDocument(options)
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
