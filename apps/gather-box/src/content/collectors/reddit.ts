import { getUrlFileName, numberFileNames } from "../../shared/path";
import {
  RESOLVE_REDGIFS_MEDIA_MESSAGE,
  sendCollectorRequest,
} from "../../shared/protocol/collector";
import type { CollectorResult, DownloadableFile } from "../../shared/types";
import type { SourcePage } from "../collector-entry";

interface RedditPost {
  id: string;
  title: string;
  element: Element;
}

export async function collect(document: Document, page: SourcePage): Promise<CollectorResult> {
  const post = getRedditPost(document, page.address.postId);

  if (!post) {
    return { ok: false, message: "This Reddit page is not a supported post URL." };
  }

  let images = collectGalleryImages(post.element);

  if (images.length === 0) {
    const contentHref = post.element.getAttribute("content-href") ?? "";
    const redditMedia = collectRedditGifVideo(post.element) ?? normalizeRedditMediaUrl(contentHref);

    if (redditMedia) {
      images = [redditMedia];
    } else {
      const redgifsId = getRedgifsId(contentHref, post.element);

      if (redgifsId) {
        const resolved = await sendCollectorRequest({
          type: RESOLVE_REDGIFS_MEDIA_MESSAGE,
          redgifsId,
        });

        if (!resolved.ok) {
          return { ok: false, message: resolved.message };
        }

        images = [resolved.media];
      }
    }
  }

  if (images.length === 0) {
    return {
      ok: false,
      message:
        "No downloadable image, GIF, gallery, or RedGIFs video was found in this Reddit post.",
    };
  }

  const gallery = images.length > 1;

  return {
    ok: true,
    outputKind: "downloadable-files",
    title: post.title,
    galleryId: post.id,
    folderSegments: gallery ? [`${post.title}_${post.id}`] : [],
    images: gallery ? numberFileNames(images) : images,
  };
}

function getRedditPost(document: Document, id: string | undefined): RedditPost | null {
  if (!id) {
    return null;
  }

  const element = document.querySelector(`shreddit-post[id="t3_${id}"][post-title]`);

  if (!element) {
    return null;
  }

  return {
    id,
    title: element.getAttribute("post-title")?.trim() || `Reddit post ${id}`,
    element,
  };
}

function collectGalleryImages(post: Element): DownloadableFile[] {
  const items = Array.from(
    post.querySelectorAll<HTMLElement>('gallery-carousel li[slot^="page-"]'),
  ).sort((left, right) => getPageNumber(left) - getPageNumber(right));

  const result: DownloadableFile[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const image = item.querySelector<HTMLImageElement>("figure img");
    const source = image?.getAttribute("data-lazy-src") || image?.getAttribute("src");
    const media = source ? normalizeRedditMediaUrl(source) : null;

    if (!media || seen.has(media.originalUrl)) {
      continue;
    }

    seen.add(media.originalUrl);
    result.push(media);
  }

  return result;
}

function collectRedditGifVideo(post: Element): DownloadableFile | null {
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
    const sourceFileName = getUrlFileName(source);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "preview.redd.it" ||
      url.searchParams.get("format")?.toLowerCase() !== "mp4" ||
      !/^[a-z0-9]+\.gif$/i.test(sourceFileName)
    ) {
      return null;
    }

    return { originalUrl: url.toString(), fileName: sourceFileName.replace(/\.gif$/i, ".mp4") };
  } catch {
    return null;
  }
}

function normalizeRedditMediaUrl(value: string): DownloadableFile | null {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") {
      return null;
    }

    const pathFileName = getUrlFileName(value);

    if (url.hostname === "i.redd.it" && isRedditMediaFileName(pathFileName)) {
      url.search = "";
      url.hash = "";

      return { originalUrl: url.toString(), fileName: pathFileName };
    }

    if (url.hostname !== "preview.redd.it") {
      return null;
    }

    const originalFileName = getPreviewOriginalFileName(pathFileName);

    if (!originalFileName) {
      return null;
    }

    return { originalUrl: `https://i.redd.it/${originalFileName}`, fileName: originalFileName };
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

      if (match?.[1]) {
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

function getPageNumber(item: Element): number {
  return Number(item.getAttribute("slot")?.match(/^page-(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}
