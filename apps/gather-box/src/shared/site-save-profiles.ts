import type { SiteKey } from "./sites";

export type FolderStrategy = "flat" | "post-folder" | "creator-nested";

export interface SiteSaveProfile {
  key: SiteKey;
  label: string;
  outputLabel: string;
  folderStrategy: FolderStrategy;
  saveRuleSummary: string;
  folderPattern: string;
  folderExample: string;
  filePattern: string;
  credentialsNote?: string;
}

export const SITE_SAVE_PROFILES: SiteSaveProfile[] = [
  {
    key: "kemono",
    label: "Kemono",
    outputLabel: "Gallery images",
    folderStrategy: "creator-nested",
    saveRuleSummary: "Creates nested folders by source type, creator, then post title.",
    folderPattern: "{type}/{creator}/{post}/",
    folderExample: "fanbox/CreatorName/Post_Title/",
    filePattern: "Original CDN filenames"
  },
  {
    key: "fanbox",
    label: "pixiv FANBOX",
    outputLabel: "Gallery images",
    folderStrategy: "creator-nested",
    saveRuleSummary: "Creates a creator folder, then a post subfolder with title and ID.",
    folderPattern: "{creator}/{title}-{post_id}/",
    folderExample: "creator/Post_Title-11929835/",
    filePattern: "Original CDN filenames",
    credentialsNote: "Session cookies included by default."
  },
  {
    key: "myhentaigallery",
    label: "MyHentaiGallery",
    outputLabel: "Gallery images",
    folderStrategy: "post-folder",
    saveRuleSummary: "Creates one folder named after the gallery title.",
    folderPattern: "{title}/",
    folderExample: "Gallery_Title/",
    filePattern: "Original CDN filenames"
  },
  {
    key: "archiveofourown",
    label: "Archive of Our Own",
    outputLabel: "Server PDF",
    folderStrategy: "flat",
    saveRuleSummary: "Saves a single PDF directly in the chosen site folder.",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf",
    filePattern: "{author}-{title}.pdf",
    credentialsNote: "Session cookies included by default."
  },
  {
    key: "hentaifoundry-stories",
    label: "Hentai Foundry Stories",
    outputLabel: "Server PDF",
    folderStrategy: "flat",
    saveRuleSummary: "Saves a single PDF directly in the chosen site folder.",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf",
    filePattern: "{author}-{title}.pdf",
    credentialsNote: "Session cookies included by default."
  },
  {
    key: "fanfiction-net",
    label: "FanFiction.Net",
    outputLabel: "Generated PDF",
    folderStrategy: "flat",
    saveRuleSummary: "Fetches all chapters and writes one merged PDF in the site folder.",
    folderPattern: "(site folder root)",
    folderExample: "Author-Title.pdf",
    filePattern: "{author}-{title}.pdf"
  }
];

const PROFILE_BY_KEY = new Map(SITE_SAVE_PROFILES.map((profile) => [profile.key, profile]));

export function getSiteSaveProfile(siteKey: SiteKey): SiteSaveProfile {
  const profile = PROFILE_BY_KEY.get(siteKey);
  if (!profile) {
    throw new Error(`Missing save profile for site: ${siteKey}`);
  }

  return profile;
}

export function buildInferredPathPreview(rootName: string, profile: SiteSaveProfile): string {
  if (profile.folderStrategy === "flat") {
    return `${rootName}/${profile.folderExample}`;
  }

  return `${rootName}/${profile.folderExample}`;
}
