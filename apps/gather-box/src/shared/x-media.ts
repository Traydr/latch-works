export const RESOLVE_X_MEDIA_MESSAGE = "GATHER_BOX_RESOLVE_X_MEDIA" as const;
export const X_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export interface ResolveXMediaMessage {
  type: typeof RESOLVE_X_MEDIA_MESSAGE;
  tweetId: string;
  mainScriptUrl: string | null;
  featureValues: Record<string, boolean>;
}

export interface ResolvedXMedia {
  type: "photo" | "video" | "animated_gif";
  originalUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
}

export interface XOperationMetadata {
  queryId: string;
  featureSwitches: string[];
  fieldToggles: string[];
}

export type ResolveXMediaResponse =
  | { ok: true; media: ResolvedXMedia[] }
  | { ok: false; message: string; operation?: XOperationMetadata };

interface XRawMedia {
  type?: unknown;
  media_url_https?: unknown;
  video_info?: {
    variants?: Array<{
      bitrate?: unknown;
      content_type?: unknown;
      url?: unknown;
    }>;
  };
}

export function isResolveXMediaMessage(message: unknown): message is ResolveXMediaMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === RESOLVE_X_MEDIA_MESSAGE &&
    "tweetId" in message &&
    typeof message.tweetId === "string"
  );
}

export function parseXMedia(rawMedia: unknown): ResolvedXMedia[] {
  if (!Array.isArray(rawMedia)) {
    return [];
  }

  const result: ResolvedXMedia[] = [];
  const seen = new Set<string>();

  for (const candidate of rawMedia) {
    if (!isObject(candidate)) {
      continue;
    }

    const media = candidate as XRawMedia;
    const type = media.type;
    const thumbnailUrl = typeof media.media_url_https === "string" ? media.media_url_https : null;

    if (type === "photo" && thumbnailUrl) {
      const url = new URL(thumbnailUrl);
      url.searchParams.set("name", "orig");
      const format = url.searchParams.get("format") ?? getPathExtension(url.pathname);
      const baseName = getPathFileName(url.pathname).replace(/\.[A-Za-z0-9]+$/, "");
      if (!format || !baseName || seen.has(url.toString())) {
        continue;
      }

      seen.add(url.toString());
      result.push({
        type: "photo",
        originalUrl: url.toString(),
        thumbnailUrl,
        fileName: `${baseName}.${format}`
      });
      continue;
    }

    if (type !== "video" && type !== "animated_gif") {
      continue;
    }

    const bestVariant = (media.video_info?.variants ?? [])
      .filter(
        (variant) =>
          variant.content_type === "video/mp4" && typeof variant.url === "string"
      )
      .sort((left, right) => Number(right.bitrate ?? 0) - Number(left.bitrate ?? 0))[0];
    if (!bestVariant || typeof bestVariant.url !== "string") {
      continue;
    }

    const url = new URL(bestVariant.url);
    url.searchParams.delete("tag");
    if (seen.has(url.toString())) {
      continue;
    }

    const fileName = getPathFileName(url.pathname);
    if (!fileName) {
      continue;
    }

    seen.add(url.toString());
    result.push({
      type,
      originalUrl: url.toString(),
      thumbnailUrl,
      fileName
    });
  }

  return result;
}

export function extractGraphqlMedia(body: unknown, tweetId: string): unknown {
  if (!isObject(body)) {
    return null;
  }

  const data = isObject(body.data) ? body.data : null;
  const timeline =
    data && isObject(data.threaded_conversation_with_injections_v2)
      ? data.threaded_conversation_with_injections_v2
      : null;
  const instructions = timeline && Array.isArray(timeline.instructions) ? timeline.instructions : [];
  const addEntries = instructions.find(
    (instruction) => isObject(instruction) && instruction.type === "TimelineAddEntries"
  );
  const entries = isObject(addEntries) && Array.isArray(addEntries.entries) ? addEntries.entries : [];
  const entry = entries.find(
    (candidate) => isObject(candidate) && candidate.entryId === `tweet-${tweetId}`
  );
  let tweetResult = getNestedObject(entry, ["content", "itemContent", "tweet_results", "result"]);

  if (tweetResult?.__typename === "TweetWithVisibilityResults" && isObject(tweetResult.tweet)) {
    tweetResult = tweetResult.tweet;
  }

  const legacy = tweetResult && isObject(tweetResult.legacy) ? tweetResult.legacy : null;
  const retweetedResult = getNestedObject(legacy, ["retweeted_status_result", "result"]);
  const unwrappedRetweet =
    retweetedResult?.__typename === "TweetWithVisibilityResults"
      ? getNestedObject(retweetedResult, ["tweet"])
      : retweetedResult;
  const retweetedLegacy =
    unwrappedRetweet && isObject(unwrappedRetweet.legacy) ? unwrappedRetweet.legacy : null;
  const retweetedMedia = getNestedValue(retweetedLegacy, ["extended_entities", "media"]);

  return retweetedMedia ?? getNestedValue(legacy, ["extended_entities", "media"]);
}

function getNestedObject(value: unknown, path: string[]): Record<string, unknown> | null {
  const nested = getNestedValue(value, path);
  return isObject(nested) ? nested : null;
}

function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function getPathFileName(pathname: string): string {
  return decodeURIComponent(pathname.split("/").pop() ?? "");
}

function getPathExtension(pathname: string): string {
  return getPathFileName(pathname).split(".").pop()?.toLowerCase() ?? "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
