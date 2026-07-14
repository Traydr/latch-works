import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";
import { getFileName, getImageSource, getText } from "./utils";

const FANBOX_IMAGE_LINK_SELECTOR = 'a[href^="https://downloads.fanbox.cc/images/post/"]';
const FANBOX_TITLE_SELECTOR = "article h1";
const FANBOX_METADATA_SELECTOR = 'meta[name="metadata"]';
const FANBOX_JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const FANBOX_IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

interface FanboxStructuredPost {
  authorName: string | null;
  headline: string | null;
}

export function collectFanboxData(document: Document, location: Location): GalleryCollectResponse {
  if (!isFanboxPostUrl(location)) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This FANBOX page is not a supported creator post URL."
    };
  }

  const creatorId = getCreatorId(document, location);
  if (!creatorId) {
    return {
      ok: false,
      code: "USER_NOT_FOUND",
      message: "Could not infer the FANBOX creator name from this page."
    };
  }

  const postId = getPostId(location);
  const title = getPostTitle(document);
  if (!title) {
    return {
      ok: false,
      code: "TITLE_NOT_FOUND",
      message: "Could not find the FANBOX post title on this page."
    };
  }

  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(FANBOX_IMAGE_LINK_SELECTOR));
  if (links.length === 0) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message: "No FANBOX image download links were found on this page."
    };
  }

  const seenUrls = new Set<string>();
  const imageEntries = links.map((link, index) => buildFanboxImageEntry(link, index, location, seenUrls));
  const images = imageEntries.filter((image): image is GalleryImage => Boolean(image));
  const skippedCount = imageEntries.length - images.length;

  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_VALID_IMAGES",
      message: "No valid FANBOX image download links could be converted into downloads."
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "fanbox",
    title,
    pageUrl: location.href,
    galleryId: postId,
    folderSegments: [creatorId, buildPostFolderName(title, postId)],
    skippedCount,
    images
  };
}

function buildFanboxImageEntry(
  link: HTMLAnchorElement,
  index: number,
  location: Location,
  seenUrls: Set<string>
): GalleryImage | null {
  const href = link.getAttribute("href");
  if (!href) {
    return null;
  }

  const originalUrl = new URL(href, location.href).toString();
  if (seenUrls.has(originalUrl) || !isFanboxImageUrl(originalUrl)) {
    return null;
  }

  seenUrls.add(originalUrl);
  const thumbnail = link.querySelector<HTMLImageElement>("img");

  return {
    pageNumber: index + 1,
    thumbnailUrl: thumbnail ? getImageSource(thumbnail, location) : null,
    originalUrl,
    fileName: getFileName(originalUrl)
  };
}

function isFanboxPostUrl(location: Location): boolean {
  return location.hostname.toLowerCase().endsWith(".fanbox.cc") && location.pathname.startsWith("/posts/");
}

function isFanboxImageUrl(value: string): boolean {
  const url = new URL(value);
  const extension = getFileExtension(url.pathname);

  return url.hostname === "downloads.fanbox.cc" && FANBOX_IMAGE_EXTENSIONS.has(extension);
}

function getCreatorId(document: Document, location: Location): string {
  const metadataCreatorId = getMetadataCreatorId(document);
  if (metadataCreatorId) {
    return metadataCreatorId;
  }

  return location.hostname.replace(/\.fanbox\.cc$/i, "");
}

function getMetadataCreatorId(document: Document): string {
  const metadata = document.querySelector<HTMLMetaElement>(FANBOX_METADATA_SELECTOR);
  const content = metadata?.getAttribute("content");
  if (!content) {
    return "";
  }

  try {
    const parsed = JSON.parse(content) as {
      urlContext?: {
        host?: {
          creatorId?: unknown;
        };
      };
    };
    const creatorId = parsed.urlContext?.host?.creatorId;

    return typeof creatorId === "string" ? creatorId.trim() : "";
  } catch {
    return "";
  }
}

function getPostTitle(document: Document): string {
  const structuredPost = getStructuredPost(document);

  return (
    structuredPost.headline ||
    getText(document.querySelector(FANBOX_TITLE_SELECTOR)) ||
    getTitleFromOpenGraph(document) ||
    getTitleFromDocumentTitle(document.title, structuredPost.authorName)
  );
}

function getStructuredPost(document: Document): FanboxStructuredPost {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>(FANBOX_JSON_LD_SELECTOR));

  for (const script of scripts) {
    const rawJson = script.textContent?.trim();
    if (!rawJson) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawJson);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const post = nodes.find((node) => isObject(node) && node["@type"] === "BlogPosting");
      if (!isObject(post)) {
        continue;
      }

      const author = post.author;
      const authorName = isObject(author) && typeof author.name === "string" ? author.name.trim() : null;
      const headline = typeof post.headline === "string" ? post.headline.trim() : null;

      return { authorName, headline };
    } catch {
      continue;
    }
  }

  return { authorName: null, headline: null };
}

function getTitleFromOpenGraph(document: Document): string {
  const title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim();
  if (!title) {
    return "";
  }

  return getTitleFromDocumentTitle(title, null);
}

function getTitleFromDocumentTitle(title: string, authorName: string | null): string {
  const suffix = authorName ? `${authorName} pixivFANBOX` : "pixivFANBOX";
  const normalizedTitle = title.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  const suffixIndex = normalizedTitle.toLowerCase().lastIndexOf(suffix.toLowerCase());

  if (suffixIndex > 0) {
    return normalizedTitle.slice(0, suffixIndex).trim();
  }

  return normalizedTitle.replace(/\bpixivFANBOX\b/i, "").trim();
}

function getPostId(location: Location): string | null {
  const match = location.pathname.match(/^\/posts\/([^/]+)/);
  return match ? match[1] : null;
}

function buildPostFolderName(title: string, postId: string | null): string {
  return postId ? `${title}-${postId}` : title;
}

function getFileExtension(pathname: string): string {
  const fileName = pathname.split("/").pop() || "";
  const extension = fileName.split(".").pop();

  return extension ? extension.toLowerCase() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
