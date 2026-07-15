import {
  RESOLVE_REDGIFS_MEDIA_MESSAGE,
  type ResolveRedgifsMediaMessage,
  type ResolveRedgifsMediaResponse
} from "../../shared/reddit-media";
import type { GalleryCollectResponse, GalleryImage } from "../../shared/types";

type RedgifsResolver = (
  message: ResolveRedgifsMediaMessage
) => Promise<ResolveRedgifsMediaResponse>;

interface RedditPost {
  id: string;
  title: string;
  element: Element;
}

export async function collectRedditData(
  document: Document,
  location: Location,
  resolveRedgifs: RedgifsResolver = resolveRedgifsMedia
): Promise<GalleryCollectResponse> {
  const post = getRedditPost(document, location);
  if (!post) {
    return {
      ok: false,
      code: "UNSUPPORTED_SITE",
      message: "This Reddit page is not a supported post URL."
    };
  }

  let images = collectGalleryImages(post.element);
  if (images.length === 0) {
    const contentHref = post.element.getAttribute("content-href") ?? "";
    const redditMedia = collectRedditGifVideo(post.element) ?? normalizeRedditMediaUrl(contentHref);
    if (redditMedia) {
      images = [toGalleryImage(redditMedia, 1)];
    } else {
      const redgifsId = getRedgifsId(contentHref, post.element);
      if (redgifsId) {
        const resolved = await resolveRedgifs({
          type: RESOLVE_REDGIFS_MEDIA_MESSAGE,
          redgifsId
        });
        if (!resolved.ok) {
          return {
            ok: false,
            code: "MEDIA_RESOLUTION_FAILED",
            message: resolved.message
          };
        }
        images = [{ pageNumber: 1, ...resolved.media }];
      }
    }
  }

  if (images.length === 0) {
    return {
      ok: false,
      code: "NO_IMAGES_FOUND",
      message:
        "No downloadable image, GIF, gallery, or RedGIFs video was found in this Reddit post."
    };
  }

  const multipleMedia = images.length > 1;
  if (multipleMedia) {
    images = addOrderedFileNamePrefixes(images);
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    site: "reddit",
    title: post.title,
    pageUrl: location.href,
    galleryId: post.id,
    folderSegments: multipleMedia ? [`${post.title}_${post.id}`] : [],
    skippedCount: 0,
    images
  };
}

function getRedditPost(document: Document, location: Location): RedditPost | null {
  const match = location.pathname.match(
    /^\/(?:r|user)\/[^/]+\/comments\/([a-z0-9]+)(?:\/[^/?#]+)?\/?$/i
  );
  if (!match) {
    return null;
  }

  const id = match[1];
  const element = document.querySelector(`shreddit-post[id="t3_${id}"][post-title]`);
  if (!element) {
    return null;
  }

  return {
    id,
    title: element.getAttribute("post-title")?.trim() || `Reddit post ${id}`,
    element
  };
}

function collectGalleryImages(post: Element): GalleryImage[] {
  const items = Array.from(
    post.querySelectorAll<HTMLElement>('gallery-carousel li[slot^="page-"]')
  ).sort((left, right) => getPageNumber(left) - getPageNumber(right));
  const result: GalleryImage[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const image = item.querySelector<HTMLImageElement>("figure img");
    const source = image?.getAttribute("data-lazy-src") || image?.getAttribute("src");
    const media = source ? normalizeRedditMediaUrl(source) : null;
    if (!media || seen.has(media.originalUrl)) {
      continue;
    }

    seen.add(media.originalUrl);
    result.push(toGalleryImage(media, result.length + 1));
  }

  return result;
}

function collectRedditGifVideo(
  post: Element
): { originalUrl: string; thumbnailUrl: string | null; fileName: string } | null {
  if (post.getAttribute("post-type") !== "gif") {
    return null;
  }

  const player = post.querySelector("shreddit-player[gif]");
  const source =
    player?.getAttribute("src") || player?.querySelector("source")?.getAttribute("src");
  if (!source) {
    return null;
  }

  try {
    const url = new URL(source);
    const sourceFileName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "preview.redd.it" ||
      url.searchParams.get("format")?.toLowerCase() !== "mp4" ||
      !/^[a-z0-9]+\.gif$/i.test(sourceFileName)
    ) {
      return null;
    }

    return {
      originalUrl: url.toString(),
      thumbnailUrl: player?.getAttribute("poster") ?? null,
      fileName: sourceFileName.replace(/\.gif$/i, ".mp4")
    };
  } catch {
    return null;
  }
}

function normalizeRedditMediaUrl(
  value: string
): { originalUrl: string; thumbnailUrl: string; fileName: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }

    const pathFileName = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (url.hostname === "i.redd.it" && isRedditMediaFileName(pathFileName)) {
      url.search = "";
      url.hash = "";
      return { originalUrl: url.toString(), thumbnailUrl: value, fileName: pathFileName };
    }

    if (url.hostname !== "preview.redd.it") {
      return null;
    }

    const originalFileName = getPreviewOriginalFileName(pathFileName);
    if (!originalFileName) {
      return null;
    }

    return {
      originalUrl: `https://i.redd.it/${originalFileName}`,
      thumbnailUrl: value,
      fileName: originalFileName
    };
  } catch {
    return null;
  }
}

function getPreviewOriginalFileName(fileName: string): string | null {
  const slugged = fileName.match(/-v\d+-([a-z0-9]+\.(?:gif|jpe?g|png|webp))$/i)?.[1];
  if (slugged) {
    return slugged;
  }

  return isRedditMediaFileName(fileName) ? fileName : null;
}

function isRedditMediaFileName(fileName: string): boolean {
  return /^[a-z0-9]+\.(?:gif|jpe?g|png|webp)$/i.test(fileName);
}

function getRedgifsId(contentHref: string, post: Element): string | null {
  for (const value of [contentHref, getRedgifsEmbedUrl(post)]) {
    if (!value) {
      continue;
    }

    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        (url.hostname !== "redgifs.com" && !url.hostname.endsWith(".redgifs.com"))
      ) {
        continue;
      }
      const match = url.pathname.match(/^\/(?:watch|ifr)\/([a-z0-9]+)\/?$/i);
      if (match) {
        return match[1];
      }
    } catch {
      // Ignore malformed page-provided URLs.
    }
  }

  return null;
}

function getRedgifsEmbedUrl(post: Element): string | null {
  const html = post.querySelector("shreddit-embed")?.getAttribute("html") ?? "";
  return html.match(/src=["'](https:\/\/[^"']+)["']/i)?.[1] ?? null;
}

function addOrderedFileNamePrefixes(images: GalleryImage[]): GalleryImage[] {
  const width = Math.max(2, String(images.length).length);
  return images.map((image, index) => ({
    ...image,
    fileName: `${String(index + 1).padStart(width, "0")}_${image.fileName}`
  }));
}

function toGalleryImage(
  media: { originalUrl: string; thumbnailUrl: string | null; fileName: string },
  pageNumber: number
): GalleryImage {
  return { pageNumber, ...media };
}

function getPageNumber(item: Element): number {
  return Number(item.getAttribute("slot")?.match(/^page-(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

async function resolveRedgifsMedia(
  message: ResolveRedgifsMediaMessage
): Promise<ResolveRedgifsMediaResponse> {
  return chrome.runtime.sendMessage<
    ResolveRedgifsMediaMessage,
    ResolveRedgifsMediaResponse
  >(message);
}
