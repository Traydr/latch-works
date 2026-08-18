import type { PageLocation } from "../collector-entry";
import { z } from "zod";
import { lenientArrayOf } from "../../shared/lenient-array";
import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";

const FANBOX_IMAGE_LINK_SELECTOR = 'a[href^="https://downloads.fanbox.cc/images/post/"]';
const FANBOX_TITLE_SELECTOR = "article h1";
const FANBOX_METADATA_SELECTOR = 'meta[name="metadata"]';
const FANBOX_JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
const FANBOX_IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

interface FanboxStructuredPost {
  authorName: string | null;
  headline: string | null;
}

/** FANBOX embeds the creator slug in a `meta[name="metadata"]` JSON blob. */
const FanboxMetadataSchema = z.object({
  urlContext: z.object({ host: z.object({ creatorId: z.string() }) })
});

/** The JSON-LD block is either a single node or an array; only BlogPosting nodes are useful. */
const FanboxBlogPostingSchema = z.object({
  "@type": z.literal("BlogPosting"),
  author: z.object({ name: z.string() }).optional(),
  headline: z.string().optional()
});

const FanboxJsonLdSchema = z
  .union([lenientArrayOf(FanboxBlogPostingSchema), FanboxBlogPostingSchema.transform((post) => [post])]);

export function collectFanboxData(document: Document, location: PageLocation): GalleryCollectResponse {
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
  location: PageLocation,
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

function isFanboxPostUrl(location: PageLocation): boolean {
  return location.hostname.toLowerCase().endsWith(".fanbox.cc") && location.pathname.startsWith("/posts/");
}

function isFanboxImageUrl(value: string): boolean {
  const url = new URL(value);
  const extension = getFileExtension(url.pathname);

  return url.hostname === "downloads.fanbox.cc" && FANBOX_IMAGE_EXTENSIONS.has(extension);
}

function getCreatorId(document: Document, location: PageLocation): string {
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
    const metadataContent = FanboxMetadataSchema.parse(JSON.parse(content));

    return metadataContent.urlContext.host.creatorId.trim();
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
      const [post] = FanboxJsonLdSchema.parse(JSON.parse(rawJson));
      if (!post) {
        continue;
      }

      return {
        authorName: post.author?.name.trim() ?? null,
        headline: post.headline?.trim() ?? null
      };
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

function getPostId(location: PageLocation): string | null {
  const match = location.pathname.match(/^\/posts\/([^/]+)/);
  return match ? match[1] : null;
}

function buildPostFolderName(title: string, postId: string | null): string {
  return postId ? `${title}-${postId}` : title;
}

function getFileName(originalUrl: string): string {
  const url = new URL(originalUrl);
  const parts = url.pathname.split("/");
  return parts[parts.length - 1] || "image";
}

function getFileExtension(pathname: string): string {
  const fileName = pathname.split("/").pop() || "";
  const extension = fileName.split(".").pop();

  return extension ? extension.toLowerCase() : "";
}

function getImageSource(image: HTMLImageElement, location: PageLocation): string | null {
  const rawSource = image.getAttribute("data-src") || image.getAttribute("src");
  if (!rawSource) {
    return null;
  }

  return new URL(rawSource, location.href).toString();
}

function getText(element: Element | null): string {
  return element ? element.textContent?.trim() || "" : "";
}
