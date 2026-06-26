import type { SiteKey } from "../shared/sites";
import { SUPPORTED_SITES } from "../shared/sites";

const PREVIEW_URLS: Record<string, string> = {
  kemono: "https://kemono.cr/fanbox/user/24921130/post/11471817",
  fanbox: "https://creator.fanbox.cc/posts/11929835",
  ao3: "https://archiveofourown.org/works/18187196",
  myhentaigallery: "https://myhentaigallery.com/a/20942",
  "hentaifoundry-stories":
    "https://www.hentai-foundry.com/stories/user/dotDelamora/70617/Taming-Guinevere",
  "fanfiction-net": "https://www.fanfiction.net/s/12620462/1/Taboo"
};

const PREVIEW_ALIASES: Record<string, SiteKey> = {
  kemono: "kemono",
  fanbox: "fanbox",
  ao3: "archiveofourown",
  mhg: "myhentaigallery",
  myhentaigallery: "myhentaigallery",
  hf: "hentaifoundry-stories",
  "hentaifoundry-stories": "hentaifoundry-stories",
  ffn: "fanfiction-net",
  "fanfiction-net": "fanfiction-net"
};

export function parsePreviewSiteKey(): SiteKey | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("preview=")) {
    return null;
  }

  const alias = hash.slice("preview=".length).trim().toLowerCase();
  return resolvePreviewSiteAlias(alias);
}

export function resolvePreviewSiteAlias(alias: string | undefined): SiteKey | null {
  if (!alias) {
    return null;
  }

  return PREVIEW_ALIASES[alias.trim().toLowerCase()] ?? null;
}

export function initPreviewSiteSwitcher(
  document: Document,
  onSelect: (siteKey: SiteKey) => void,
  initialSiteKey: SiteKey
): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-preview-site]");
  setPreviewSiteButtonState(buttons, initialSiteKey);

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const siteKey = resolvePreviewSiteAlias(button.dataset.previewSite);
      if (!siteKey) {
        return;
      }

      setPreviewSiteButtonState(buttons, siteKey);
      onSelect(siteKey);
    });
  }
}

function setPreviewSiteButtonState(
  buttons: NodeListOf<HTMLButtonElement>,
  activeSiteKey: SiteKey
): void {
  for (const button of buttons) {
    const siteKey = resolvePreviewSiteAlias(button.dataset.previewSite);
    const active = siteKey === activeSiteKey;
    button.classList.toggle("preview-site-btn-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

export function getPreviewTabUrl(siteKey: SiteKey): string {
  return PREVIEW_URLS[siteKey] ?? "";
}

export function getPreviewSiteLabel(siteKey: SiteKey): string {
  return SUPPORTED_SITES.find((site) => site.key === siteKey)?.label ?? siteKey;
}
