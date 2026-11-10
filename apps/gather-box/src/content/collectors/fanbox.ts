import * as z from "zod/mini";
import { lenientArrayOf } from "../../shared/lenient-array";
import { getUrlFileName } from "../../shared/path";
import type { CollectorResult, DownloadableFile } from "../../shared/types";
import { getText } from "../collector-dom";
import type { SourcePage } from "../collector-entry";

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
  urlContext: z.object({ host: z.object({ creatorId: z.string() }) }),
});

/** The JSON-LD block is either a single node or an array; only BlogPosting nodes are useful. */
const FanboxBlogPostingSchema = z.object({
  "@type": z.literal("BlogPosting"),
  author: z.optional(z.object({ name: z.string() })),
  headline: z.optional(z.string()),
});

const FanboxJsonLdSchema = z.union([
  lenientArrayOf(FanboxBlogPostingSchema),
  z.pipe(
    FanboxBlogPostingSchema,
    z.transform((post) => [post]),
  ),
]);

export function collect(document: Document, page: SourcePage): CollectorResult {
  const { creator, postId } = page.address;

  if (!creator || !postId) {
    return { ok: false, message: "This FANBOX page is not a supported creator post URL." };
  }

  const creatorId = getMetadataCreatorId(document) || creator;
  const title = getPostTitle(document);

  if (!title) {
    return { ok: false, message: "Could not find the FANBOX post title on this page." };
  }

  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(FANBOX_IMAGE_LINK_SELECTOR),
  );

  if (links.length === 0) {
    return { ok: false, message: "No FANBOX image download links were found on this page." };
  }

  const seenUrls = new Set<string>();

  const images = links.flatMap((link) => {
    const image = buildFanboxImageEntry(link, page, seenUrls);

    return image ? [image] : [];
  });

  if (images.length === 0) {
    return {
      ok: false,
      message: "No valid FANBOX image download links could be converted into downloads.",
    };
  }

  return {
    ok: true,
    outputKind: "downloadable-files",
    title,
    galleryId: postId,
    folderSegments: [creatorId, `${title}-${postId}`],
    images,
  };
}

function buildFanboxImageEntry(
  link: HTMLAnchorElement,
  page: SourcePage,
  seenUrls: Set<string>,
): DownloadableFile | null {
  const href = link.getAttribute("href");

  if (!href) {
    return null;
  }

  const originalUrl = new URL(href, page.location.href).toString();

  if (seenUrls.has(originalUrl) || !isFanboxImageUrl(originalUrl)) {
    return null;
  }

  seenUrls.add(originalUrl);

  return { originalUrl, fileName: getUrlFileName(originalUrl) || "image" };
}

function isFanboxImageUrl(value: string): boolean {
  const url = new URL(value);
  const extension = getFileExtension(url.pathname);

  return url.hostname === "downloads.fanbox.cc" && FANBOX_IMAGE_EXTENSIONS.has(extension);
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
        headline: post.headline?.trim() ?? null,
      };
    } catch {}
  }

  return { authorName: null, headline: null };
}

function getTitleFromOpenGraph(document: Document): string {
  const title = document
    .querySelector<HTMLMetaElement>('meta[property="og:title"]')
    ?.content.trim();

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

function getFileExtension(pathname: string): string {
  const fileName = pathname.split("/").pop() || "";
  const extension = fileName.split(".").pop();

  return extension ? extension.toLowerCase() : "";
}
